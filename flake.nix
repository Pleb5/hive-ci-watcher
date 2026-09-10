{
  description = "hive-ci-watcher — a headless daemon that dispatches Hive CI runs for Nostr repositories";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
    flake-utils.url = "github:numtide/flake-utils";
  };

  outputs = {
    self,
    nixpkgs,
    flake-utils,
  }: let
    systemOutputs = flake-utils.lib.eachDefaultSystem (system: let
      pkgs = import nixpkgs {inherit system;};
      nodejs = pkgs.nodejs_22;
    in {
      packages.default = pkgs.stdenv.mkDerivation (finalAttrs: {
        pname = "hive-ci-watcher";
        version = "0.1.0";
        src = ./.;

        nativeBuildInputs = [
          nodejs
          pkgs.pnpm.configHook
          pkgs.python3
          pkgs.makeWrapper
        ];

        # better-sqlite3 is compiled against the pinned nodejs rather than
        # taking a prebuilt binary, so the native module and the runtime ABI
        # cannot drift apart.
        buildInputs = [pkgs.sqlite];

        pnpmDeps = pkgs.pnpm.fetchDeps {
          inherit (finalAttrs) pname version src;
          # Update with:
          #   nix build .#default 2>&1 | grep 'got:'
          hash = pkgs.lib.fakeHash;
        };

        env.npm_config_build_from_source = "true";

        buildPhase = ''
          runHook preBuild
          pnpm build
          runHook postBuild
        '';

        installPhase = ''
          runHook preInstall

          mkdir -p $out/lib/hive-ci-watcher
          cp -r dist node_modules package.json $out/lib/hive-ci-watcher/

          makeWrapper ${nodejs}/bin/node $out/bin/hive-ci-watcherd \
            --add-flags $out/lib/hive-ci-watcher/dist/main.js \
            --prefix PATH : ${pkgs.lib.makeBinPath [pkgs.git]}

          makeWrapper ${nodejs}/bin/node $out/bin/hive-ci-watcher \
            --add-flags $out/lib/hive-ci-watcher/dist/cli/index.js

          runHook postInstall
        '';

        meta = {
          description = "Watches Nostr repositories and dispatches Hive CI runs";
          mainProgram = "hive-ci-watcherd";
          license = pkgs.lib.licenses.mit;
          platforms = pkgs.lib.platforms.unix;
        };
      });

      devShells.default = pkgs.mkShell {
        packages = [
          nodejs
          pkgs.pnpm
          pkgs.git
          pkgs.sqlite
          pkgs.act
          pkgs.nak
          pkgs.python3
        ];
      };

      formatter = pkgs.alejandra;
    });
  in
    systemOutputs
    // {
      nixosModules.default = {
        config,
        lib,
        pkgs,
        ...
      }: let
        cfg = config.services.hive-ci-watcher;
      in {
        options.services.hive-ci-watcher = {
          enable = lib.mkEnableOption "the Hive CI watcher daemon";

          package = lib.mkOption {
            type = lib.types.package;
            default = self.packages.${pkgs.stdenv.hostPlatform.system}.default;
            description = "The hive-ci-watcher package to run.";
          };

          ownerPubkey = lib.mkOption {
            type = lib.types.str;
            description = ''
              Watcher owner pubkey (hex or npub). Implicitly authorized for
              every ContextVM tool; needs no allowlist entry.
            '';
          };

          nsecFile = lib.mkOption {
            type = lib.types.path;
            description = ''
              Path to a file containing only the watcher's secret key (hex or
              nsec). Read via systemd credentials so the key never enters the
              Nix store — point this at a sops-nix or agenix output.
            '';
          };

          relays = lib.mkOption {
            type = lib.types.listOf lib.types.str;
            default = ["wss://relay.budabit.club" "wss://nos.lol" "wss://relay.damus.io"];
            description = "Default relay set, unioned with each followed repo's announced relays.";
          };

          blossomServers = lib.mkOption {
            type = lib.types.listOf lib.types.str;
            default = ["https://blossom.budabit.club" "https://blossom.primal.net" "https://cdn.sovbit.host"];
            description = "Ordered Blossom servers; the first that answers wins.";
          };

          databasePath = lib.mkOption {
            type = lib.types.str;
            default = "/var/lib/hive-ci-watcher/watcher.db";
            description = "SQLite database path.";
          };

          logLevel = lib.mkOption {
            type = lib.types.enum ["debug" "info" "warn" "error"];
            default = "info";
            description = "Daemon log level.";
          };
        };

        config = lib.mkIf cfg.enable {
          systemd.services.hive-ci-watcher = {
            description = "Hive CI watcher";
            wantedBy = ["multi-user.target"];
            after = ["network-online.target"];
            wants = ["network-online.target"];

            environment = {
              HIVE_CI_WATCHER_OWNER_PUBKEY = cfg.ownerPubkey;
              HIVE_CI_WATCHER_DB = cfg.databasePath;
              HIVE_CI_WATCHER_RELAYS = lib.concatStringsSep "," cfg.relays;
              HIVE_CI_WATCHER_BLOSSOM_SERVERS = lib.concatStringsSep "," cfg.blossomServers;
              HIVE_CI_WATCHER_LOG_LEVEL = cfg.logLevel;
            };

            # §4 shells out to git, so it must be on the unit's PATH.
            path = [pkgs.git];

            serviceConfig = {
              Type = "simple";
              # The nsec is loaded as a systemd credential and exported by the
              # shell wrapper, so it is never a store path and never appears in
              # the unit's environment block.
              LoadCredential = "nsec:${cfg.nsecFile}";
              ExecStart = "${pkgs.writeShellScript "hive-ci-watcher-start" ''
                export HIVE_CI_WATCHER_NSEC="$(tr -d '[:space:]' < "$CREDENTIALS_DIRECTORY/nsec")"
                exec ${lib.getExe cfg.package}
              ''}";

              Restart = "on-failure";
              RestartSec = 10;

              DynamicUser = true;
              StateDirectory = "hive-ci-watcher";
              StateDirectoryMode = "0700";

              NoNewPrivileges = true;
              ProtectSystem = "strict";
              ProtectHome = true;
              PrivateTmp = true;
              PrivateDevices = true;
              ProtectKernelTunables = true;
              ProtectKernelModules = true;
              ProtectControlGroups = true;
              RestrictAddressFamilies = ["AF_INET" "AF_INET6" "AF_UNIX"];
              RestrictNamespaces = true;
              RestrictRealtime = true;
              LockPersonality = true;
              MemoryDenyWriteExecute = false; # V8 JITs.
              SystemCallArchitectures = "native";
              SystemCallFilter = ["@system-service" "~@privileged" "~@resources"];
              CapabilityBoundingSet = "";
              UMask = "0077";
            };
          };
        };
      };
    };
}
