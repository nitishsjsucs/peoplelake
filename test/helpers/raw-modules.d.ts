// Vite `?raw` imports (file contents as a string), used by tests that read committed fixtures.
declare module "*?raw" {
  const text: string;
  export default text;
}
