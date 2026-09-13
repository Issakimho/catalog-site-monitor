// Public addresses and test inputs only. No merchant or private-repository data.
export const sites = [
  { id: "fr", origin: "https://pcarchitecte.com", data: "/data/", quiz: "/recommandations/", maxAgeHours: 16, minFresh: 100 },
  { id: "us", origin: "https://architectlaptops.com", data: "/data/", quiz: "/recommendations/", maxAgeHours: 26, minFresh: 20 },
  { id: "de", origin: "https://architektenrechner.com", data: "/data/de-DE/", quiz: "/empfehlungen/", maxAgeHours: 26, minFresh: 20 },
  { id: "es", origin: "https://pcarquitectos.com", data: "/data/", quiz: "/recomendaciones/", maxAgeHours: 26, minFresh: 20 },
  { id: "it", origin: "https://archiscelta.com", data: "/data/", quiz: "/consigli/", maxAgeHours: 26, minFresh: 20 }
];

export const profiles = [
  { id: "drawing", software: "autocad,sketchup", budget: 1500, load: "light" },
  { id: "bim", software: "autocad,revit", budget: 1800, load: "standard" },
  { id: "rendering", software: "revit,twinmotion", budget: 2200, load: "standard" }
];

export const FORECAST_HOURS = 12;
export const LISTING_HOURS = 48; // Mirrors published applications; not a merchant cache licence.
