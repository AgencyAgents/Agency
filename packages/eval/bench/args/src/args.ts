export interface Parsed {
  flags: Record<string, string | true>;
  rest: string[];
}

/** `--name value`, `--name=value`, `--flag` (true when the next word is another flag or absent), then the rest. */
export function parseArgs(argv: string[]): Parsed {
  const flags: Record<string, string | true> = {};
  const rest: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const word = argv[i] as string;
    if (word === "--") {
      rest.push(...argv.slice(i + 1));
      break;
    }
    if (!word.startsWith("--")) {
      rest.push(word);
      continue;
    }
    const name = word.slice(2);
    const next = argv[i + 1];
    if (next !== undefined && !next.startsWith("--")) {
      flags[name] = next;
      i++;
    } else flags[name] = true;
  }
  return { flags, rest };
}
