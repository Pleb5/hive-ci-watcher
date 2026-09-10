/**
 * GitHub filter-pattern matching for ref names.
 *
 * Matches the *short* name (`main`, `v1.2.0`, `release/1.x`), so `/` is a
 * meaningful separator: `*` does not cross it, `**` does, `?` matches one
 * non-separator character. Everything else is literal.
 *
 * `+` and `[]` character ranges from GitHub's full pattern syntax are not
 * implemented; they are treated as literals, which under-matches rather than
 * over-matching — a workflow that does not fire is recoverable, a workflow
 * that fires on the wrong ref is not.
 */
export function globToRegExp(pattern: string): RegExp {
  let source = '^'

  for (let index = 0; index < pattern.length; index += 1) {
    const char = pattern[index]!

    if (char === '*') {
      if (pattern[index + 1] === '*') {
        source += '.*'
        index += 1
      } else {
        source += '[^/]*'
      }
      continue
    }

    if (char === '?') {
      source += '[^/]'
      continue
    }

    source += char.replace(/[.+^${}()|[\]\\]/g, '\\$&')
  }

  return new RegExp(`${source}$`)
}

export function globMatch(pattern: string, name: string): boolean {
  return globToRegExp(pattern).test(name)
}

/**
 * Evaluates one of GitHub's pattern lists against a ref's short name.
 *
 * A leading `!` negates, and the *last* matching pattern decides — GitHub's
 * documented ordering rule. A list made only of negations matches everything
 * it does not explicitly exclude.
 */
export function matchesPatternList(patterns: string[], name: string): boolean {
  let matched = false
  let sawPositive = false

  for (const pattern of patterns) {
    if (pattern.startsWith('!')) {
      if (globMatch(pattern.slice(1), name)) matched = false
    } else {
      sawPositive = true
      if (globMatch(pattern, name)) matched = true
    }
  }

  if (!sawPositive) {
    return !patterns.some(pattern => globMatch(pattern.slice(1), name))
  }

  return matched
}
