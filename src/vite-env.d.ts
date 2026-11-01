/// <reference types="vite/client" />

declare module 'virtual:bundled-charts' {
  /** One entry per `charts/*.narg`, sorted by file name. `chart` is the raw (unvalidated) chart.json. */
  const charts: { file: string; url: string; chart: unknown }[];
  export default charts;
}
