# DXFs 3D

Visualizador 3D para DXF e STEP/STP com Three.js.

## O que o projeto faz

- Importa DXF no navegador (pipeline JS + worker).
- Importa DXF via backend Python com seletor `CPU/CUDA` (fallback automatico para CPU).
- Importa STEP/STP via API Python local (`/api/parse-step`) convertendo para STL.
- Permite mover pecas na cena, selecionar/excluir e enquadrar (Fit).
- Mantem cache local de parse/malha no navegador.

## Estrutura essencial

- `index.html`
- `styles.css`
- `app.js`
- `dxf-worker.js`
- `server.py`
- `run_server.py`
- `requirements.txt`

## Requisitos

- Python 3.9+
- Dependencia base: `ezdxf`
- Para STEP/STP: `cadquery` (opcional, mas necessario para converter STEP)
- Para DXF com CUDA: `cupy-cuda12x` (opcional)

## Como rodar

### Modo completo (DXF + STEP)

```powershell
cd C:\Users\USER\Downloads\dxf-3d-viewer\TESTE
py -3.9 -m pip install -r requirements.txt
py -3.9 run_server.py
```

Abra: `http://127.0.0.1:5173`

### Sem `run_server.py` (direto)

```powershell
py -3.9 server.py --host 127.0.0.1 --port 5173 --dir .
```

## STEP nao funciona?

Se a importacao STEP retornar indisponivel, instale `cadquery` no mesmo Python usado para rodar o servidor.

## CUDA nao funciona?

O backend faz fallback automatico para CPU quando CuPy/CUDA nao estao disponiveis.

Para habilitar CUDA no parse DXF:

```powershell
py -3.9 -m pip install cupy-cuda12x
```

## Endpoint local

- `POST /api/parse-dxf`
- `POST /api/parse-step`
