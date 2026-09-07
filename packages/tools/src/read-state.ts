/**
 * Tracks which files the model has actually read this session, so write can
 * warn before clobbering a file it never saw. Paths are the sandbox-resolved
 * absolute forms read/edit produce, keyed once per builtin-set instance.
 */
export class ReadState {
  private readonly paths = new Set<string>();

  mark(path: string): void {
    this.paths.add(path);
  }

  has(path: string): boolean {
    return this.paths.has(path);
  }
}
