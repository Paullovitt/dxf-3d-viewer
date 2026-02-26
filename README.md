# DXF 3D Viewer (Three.js)

## Como rodar
Opção 1 (recomendado): servidor local

### Python
1. Abra o terminal na pasta do projeto
2. Rode:
   - `python -m http.server 5173`
3. Abra no navegador:
   - `http://localhost:5173`

Opção 2: Live Server (VS Code)
- Clique com o botão direito no `index.html` -> "Open with Live Server"

## Importação
- Clique em "Importar DXF(s)" e selecione 1 ou mais arquivos `.dxf`.

## Observações
- Este demo extruda apenas **LWPOLYLINE/POLYLINE fechada**.
- Se seu DXF tiver ARCs/SPLINE/CIRCLE, precisa converter/flatten ou implementar suporte.
