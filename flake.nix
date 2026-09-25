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

          persistKey = lib.mkOption {
            type = lib.types.bool;
            default = false;
            description = ''
              Generate the watcher key once and keep it in the state directory
              (`watcher.key`, mode 0600), so the identity survives restarts.
              Off by default: the daemon then generates a fresh key on every
              start and logs its pubkey. Ignored when `nsecFile` is set.
            '';
          };

          nsecFile = lib.mkOption {
            type = lib.types.nullOr lib.types.path;
            default = null;
            description = ''
              Path to a file containing only the watcher's secret key (hex or
              nsec), for an identity you manage yourself. Read via systemd
              credentials so the key never enters the Nix store — point this
              at a sops-nix or agenix output. Takes precedence over
              `persistKey`.
            '';
          };

          relays = lib.mkOption {
            type = lib.types.nullOr (lib.types.listOf lib.types.str);
            default = null;
            description = "Explicit service inbox/outbox shorthand. Null derives from optional communities.";
          };

          inboxRelays = lib.mkOption {
            type = lib.types.nullOr (lib.types.listOf lib.types.str);
            default = null;
            description = "Explicit operational inbox override; null permits shorthand/community derivation.";
          };

          outboxRelays = lib.mkOption {
            type = lib.types.nullOr (lib.types.listOf lib.types.str);
            default = null;
            description = "Explicit operational outbox override; null permits shorthand/community derivation.";
          };

          identityDiscoveryRelays = lib.mkOption {
            type = lib.types.listOf lib.types.str;
            default = ["wss://purplepag.es"];
            description = "Identity / NIP-65 discovery. Empty disables this path.";
          };

          gitDiscoveryRelays = lib.mkOption {
            type = lib.types.listOf lib.types.str;
            default = ["wss://index.ngit.dev"];
            description = "Repository announcement discovery only.";
          };

          serviceDiscoveryRelays = lib.mkOption {
            type = lib.types.listOf lib.types.str;
            default = ["wss://relay.contextvm.org" "wss://relay2.contextvm.org"];
            description = "ContextVM service discovery only.";
          };

          blossomServers = lib.mkOption {
            type = lib.types.nullOr (lib.types.listOf lib.types.str);
            default = null;
            description = "Explicit ordered Blossom override; null derives from communities.";
          };

          databasePath = lib.mkOption {
            type = lib.types.str;
            default = "/var/lib/hive-ci-watcher/watcher.db";
            description = "SQLite database path.";
          };

          communitiesFile = lib.mkOption {
            type = lib.types.nullOr lib.types.str;
            default = null;
            description = ''
              Runtime path to the community-access JSON configuration, for example
              /etc/hive-ci-watcher/communities.json. Must be readable by the service.
              Changes take effect on restart. Unset uses operator/manual grants only.
            '';
          };

          logLevel = lib.mkOption {
            type = lib.types.enum ["debug" "info" "warn" "error"];
            default = "info";
            description = "Daemon log level (the watcher's own logger).";
          };

          sdkLogLevel = lib.mkOption {
            type = lib.types.enum ["trace" "debug" "info" "warn" "error" "silent"];
            default = "warn";
            description = ''
              Log level for the ContextVM / applesauce SDK logger (pino, JSON
              on stderr). `trace` shows every relay message and gift wrap.
            '';
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
              HIVE_CI_WATCHER_KEY_FILE = lib.mkIf (cfg.persistKey && cfg.nsecFile == null) "/var/lib/hive-ci-watcher/watcher.key";
              HIVE_CI_WATCHER_DB = cfg.databasePath;
              HIVE_CI_WATCHER_COMMUNITIES_FILE = lib.mkIf (cfg.communitiesFile != null) cfg.communitiesFile;
              HIVE_CI_WATCHER_RELAYS = lib.mkIf (cfg.relays != null) (lib.concatStringsSep "," cfg.relays);
              HIVE_CI_WATCHER_INBOX_RELAYS = lib.mkIf (cfg.inboxRelays != null) (lib.concatStringsSep "," cfg.inboxRelays);
              HIVE_CI_WATCHER_OUTBOX_RELAYS = lib.mkIf (cfg.outboxRelays != null) (lib.concatStringsSep "," cfg.outboxRelays);
              HIVE_CI_WATCHER_BLOSSOM_SERVERS = lib.mkIf (cfg.blossomServers != null) (lib.concatStringsSep "," cfg.blossomServers);
              HIVE_CI_WATCHER_IDENTITY_DISCOVERY_RELAYS = lib.concatStringsSep "," cfg.identityDiscoveryRelays;
              HIVE_CI_WATCHER_GIT_DISCOVERY_RELAYS = lib.concatStringsSep "," cfg.gitDiscoveryRelays;
              HIVE_CI_WATCHER_SERVICE_DISCOVERY_RELAYS = lib.concatStringsSep "," cfg.serviceDiscoveryRelays;
              HIVE_CI_WATCHER_LOG_LEVEL = cfg.logLevel;
              LOG_LEVEL = cfg.sdkLogLevel;
            };

            # §4 shells out to git, so it must be on the unit's PATH.
            path = [pkgs.git];

            serviceConfig = {
              Type = "simple";
              # With nsecFile set, the nsec is loaded as a systemd credential and
              # exported by the shell wrapper, so it is never a store path and
              # never appears in the unit's environment block. Without it the
              # daemon generates its own key per boot.
              LoadCredential = lib.mkIf (cfg.nsecFile != null) "nsec:${cfg.nsecFile}";
              ExecStart = "${pkgs.writeShellScript "hive-ci-watcher-start" ''
                if [ -n "''${CREDENTIALS_DIRECTORY:-}" ] && [ -r "$CREDENTIALS_DIRECTORY/nsec" ]; then
                  export HIVE_CI_WATCHER_NSEC="$(tr -d '[:space:]' < "$CREDENTIALS_DIRECTORY/nsec")"
                fi
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
