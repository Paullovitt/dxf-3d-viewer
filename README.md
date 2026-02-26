# DXF 3D Viewer (Three.js)

## Como rodar
Opcao 1 (recomendado - igual CNC, com parser Python + fallback JS)

1. Abra o terminal na pasta do projeto.
2. Instale dependencia (uma vez):
   - `pip install ezdxf`
3. Rode:
   - `python server.py --host 127.0.0.1 --port 5173`
4. Abra no navegador:
   - `http://127.0.0.1:5173`

Opcao 2 (somente estatico, parser JS local)
- `python -m http.server 5173`

## Importacao DXF
- Clique em `Importar DXF(s)` e selecione arquivos `.dxf`.
- Fluxo atual:
  1. tenta parser Python (`/api/parse-dxf`)
  2. se falhar, usa parser JS local
  3. se ainda falhar, usa fallback via `dxf-parser`

## Notas
- Selecao destaca a borda real da geometria.
- Layout/grade e controles foram mantidos.
