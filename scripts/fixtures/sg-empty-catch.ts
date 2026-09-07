export function first(): string {
  try {
    doWork();
  } catch (_e) {}
  return "one";
}

export function second(): string {
  try {
    doWork();
  } catch (_err) {}
  return "two";
}

export function third(): string {
  try {
    doWork();
  } catch (e) {
    console.error(e);
  }
  return "three";
}

declare function doWork(): void;
