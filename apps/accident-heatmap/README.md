# Vienna Accident Heatmap

An interactive web app that renders, styles and exports heat maps of Vienna traffic accidents using data from the [Statistik Austria OGD](https://www.data.gv.at/katalog/dataset/strassenverkehrsunfalle-mit-personenschaden-ab-2009).

## Features

- **Heatmap visualisation** – all accidents in Vienna rendered as a density heatmap on an interactive map
- **Filtering**
  - Year range (2009 → current)
  - Involvement type: cyclists · pedestrians · motorcyclists
  - Severity: fatal · serious injury · minor injury
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

Accident data is fetched from Statistik Austria's Open Government Data portal ([OGDEXT_UNFALLSRV_1](https://data.statistik.gv.at/web/meta.jsp?dataset=OGDEXT_UNFALLSRV_1)) via WMS `GetFeatureInfo` sampling. The processed JSON is committed back to the repo and served as a static file.

Note: this source currently exposes involvement categories (cyclist/pedestrian/motorcycle) but not injury severity attributes in the feature payload.

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
WMS_QUERY_COUNT=600 WMS_CONCURRENCY=10 npm run fetch-data
```

## Workflows

| Workflow | Trigger | Purpose |
|---|---|---|
| `fetch-accident-data.yml` | Monthly / manual | Download & cache accident data |
| `deploy-pages.yml` | Push to `main` / after data fetch | Deploy to GitHub Pages |
