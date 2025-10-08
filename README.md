# Generador de Mapas

Aplicación web local con Node.js + Express y Leaflet para:

- Ingresar una o varias direcciones (una por línea)
- Geocodificar con Nominatim (OpenStreetMap)
- Agregar manualmente direcciones no encontradas (lat/lon o clic en el mapa)
- Visualizar en mapa con estilo claro y clustering de marcadores
- Guardar/cargar las direcciones en JSON local
- Exportar el mapa a PNG

## Requisitos

- Node.js 18 o superior (recomendado)

## Instalación

```bash
npm install
```

## Inicio

```bash
npm start
```

Abre `http://localhost:3000` en tu navegador.

## Notas

- Se usa Leaflet con un fondo tipo "Positron" (CARTO) para un estilo claro similar a mapas limpios con etiquetas legibles.
- La geocodificación se realiza mediante un proxy local (`/api/geocode`) hacia Nominatim con un `User-Agent` adecuado. Úsalo de forma responsable.
- Los marcadores se agrupan con `leaflet.markercluster` para evitar superposiciones. Las etiquetas se muestran en la ventana emergente (popup) para minimizar el ruido visual.
- El guardado se realiza en `data/addresses.json`.

## Geocodificación rápida (Mapbox)

- Para mayor velocidad y mejores aciertos, puedes usar Mapbox como motor.
- Requiere token de acceso (`MAPBOX_TOKEN`). Crea uno en tu cuenta de Mapbox.
- Desde CMD (Windows):

```
set MAPBOX_TOKEN=tu_token_aqui && npm start
```

- En la app elige “Mapbox (rápido, requiere token)” o deja “Auto” (Auto usará Mapbox si el token está presente y si no, intentará Georef y luego Nominatim).

## Geocodificación con Georef (Argentina)

- Se agregó soporte para el API Georef (`apis.datos.gob.ar/georef/api`).
- En la barra lateral podrás elegir el motor de geocodificación: `Auto (Georef + Nominatim)`, `Georef (Argentina)` o `Nominatim (OSM)`.
- En modo `Auto`, se intenta primero Georef y, si no hay resultados, se recurre a Nominatim.
- La opción "Restringir resultados a Comuna 9 (CABA)" aplica filtros/bias tanto para Georef como para Nominatim.
