# playground

Monorepo for tiny web apps by [wirmachen.wien](https://wirmachen.wien).

## Apps

| App | Description | Live |
|-----|-------------|------|
| [accident-heatmap](apps/accident-heatmap/) | Interactive heatmap of Vienna traffic accidents (Statistik Austria OGD) | [GitHub Pages](https://wirmachenwien.github.io/playground/) |

## Structure

```
apps/
  accident-heatmap/   # Vienna accident heatmap
.github/
  workflows/
    fetch-accident-data.yml   # Monthly data fetch
    deploy-pages.yml          # GitHub Pages deployment
```
