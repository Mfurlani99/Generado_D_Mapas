# Mapeador de direcciones

Programa web local para mapear direcciones, etiquetarlas y exportar el resultado a PDF.

## Uso

1. Descomprimir el ZIP.
2. Abrir `index.html` con Chrome o Edge.
3. Pegar una dirección por línea.
4. Presionar **Mapear direcciones**.
5. Ajustar etiquetas, tamaño de marcas, tamaño de letra y agrupación.
6. Exportar con **Generar PDF**.

## Cambios incluidos

- Control para agrandar o achicar las marcas.
- Búsqueda optimizada para Ciudad Autónoma de Buenos Aires y Comuna 9.
- Opción para limitar los resultados a Comuna 9.
- Agrupación automática de puntos muy cercanos. Por ejemplo, si los puntos 1 y 2 quedan superpuestos, se muestra un marcador agrupado con `1,2`.
- Control de distancia de agrupación en píxeles.
- Orden manual de direcciones mediante flechas.
- Etiquetas movibles y reacomodables automáticamente.
- Exportación a PDF en A4, A3, Carta o tamaño personalizado.

## Nota

La búsqueda usa OpenStreetMap/Nominatim. Necesita internet. Algunas direcciones pueden requerir escribir el nombre de calle sin abreviaturas si el servicio externo no las reconoce.
