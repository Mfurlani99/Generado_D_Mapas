# Mapeador de direcciones

Programa web local para mapear direcciones de Comuna 9, corregir puntos manualmente y exportar un mapa legible a PDF con números y leyenda.

## Uso

1. Descomprimir el ZIP.
2. Abrir `index.html` con Chrome o Edge.
3. Pegar una dirección por línea.
4. Presionar **Mapear direcciones**.
5. Ajustar marcas, textos opcionales, orden, agrupación y ubicaciones.
6. Exportar con **Generar PDF**.

## Cambios incluidos

- Control para agrandar o achicar las marcas.
- Búsqueda optimizada para Comuna 9 con variantes de CABA, Mataderos, Liniers y Parque Avellaneda.
- Opción para limitar los resultados a Comuna 9.
- Agrupación automática de puntos muy cercanos. Por ejemplo, si los puntos 1 y 2 quedan superpuestos, se muestra un marcador agrupado con `1,2`.
- Control de distancia de agrupación en píxeles.
- Orden manual de direcciones mediante flechas, rebúsqueda, borrado y reubicación con clic en el mapa.
- Mapa limpio con marcadores numerados y leyenda lateral para impresión.
- Textos opcionales en el mapa sin cuadros ni líneas guía.
- Botón para ocultar o mostrar el panel de controles.
- Exportación a PDF en A4, A3, Carta, Oficio mexicano o tamaño personalizado.
- Estilo visual tipo consola Linux antigua.

## Nota

La búsqueda usa OpenStreetMap/Nominatim. Necesita internet. Algunas direcciones pueden requerir escribir el nombre de calle sin abreviaturas si el servicio externo no las reconoce.
