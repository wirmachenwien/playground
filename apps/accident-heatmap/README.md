# Vienna Accident Heatmap

An interactive web app that renders, styles and exports heat maps of Vienna traffic accidents using data from the [Statistik Austria OGD](https://www.data.gv.at/datasets/77e3a534-8234-38bf-aab0-15f262c2318d?locale=de).

## Features

- **Heatmap visualisation** – all accidents in Vienna rendered as a density heatmap on an interactive map
- **Filtering**
  - Year range (2009 → current)
  - Involvement type: cyclists · pedestrians · motorcyclists · cars (PKW) · other vehicles
- **Customisation**
  - 5 colour schemes (Fire, Classic, Plasma, Viridis, Cool)
  - Adjustable radius, blur and opacity
  - Dark / light / no-basemap tile styles
- **Export**
  - Draw a selection box anywhere on the map
  - Choose a preset aspect ratio (1:1, 16:9, 9:16, 4:5) or free-form
  - Set a custom output width (default 1 200 px)
  - Download as PNG with attribution watermark

## Data

Accident data is fetched from Statistik Austria's Open Government Data portal ([77e3a534-8234-38bf-aab0-15f262c2318d](https://www.data.gv.at/datasets/77e3a534-8234-38bf-aab0-15f262c2318d?locale=de)) via the ATLAS_UNFALL_OPEN WFS service and full `GetFeature` pagination.

The fetch script now downloads **all available accident features in Austria from 2013 onward**, stores full per-accident property payloads in `records`, and additionally emits compact `points` for heatmap rendering. The processed JSON is committed back to the repo and served as a static file.

**Source:** Straßenverkehrsunfälle mit Personenschaden · Statistik Austria  
**License:** Creative Commons Attribution 4.0 (CC BY 4.0)

## Deployment

The app is served as a static site via **GitHub Pages** from the `apps/accident-heatmap/` directory.

## Local development

No build step required.  Open `index.html` in a browser (you need a local HTTP server because of `fetch('data/accidents.json')`):

```bash
# from the repo root
npx serve apps/accident-heatmap
```

To fetch fresh data locally:

```bash
cd apps/accident-heatmap
npm install
npm run fetch-data
```

Optional tuning for local fetch speed/coverage:

```bash
WFS_PAGE_SIZE=10000 ACCIDENT_YEAR_FROM=2013 npm run fetch-data
```

If you see intermittent `fetch failed` errors from the Statistik Austria host, lower `WFS_PAGE_SIZE` and retry.

## Workflows

| Workflow | Trigger | Purpose |
|---|---|---|
| `fetch-accident-data.yml` | Monthly / manual | Download & cache accident data |
| `deploy-pages.yml` | Push to `main` / after data fetch | Deploy to GitHub Pages |
