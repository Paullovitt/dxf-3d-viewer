# DXF 3D Viewer - CEF + Backend Nativo (TESTE)

Versao nova criada em `C:\Users\USER\Downloads\dxf-3d-viewer\TESTE` sem alterar o projeto original.

## Arquitetura

- Frontend: `frontend/index.html`, `frontend/styles.css`, `frontend/app.js` (apenas interface/renderizacao).
- Backend nativo: `backend/server.py` (parse DXF pesado, cache, modo CPU/CUDA).
- Desktop: `run_cef.py` (abre Chromium embutido via CEF, sem depender de Chrome instalado no Windows).

## Modo de processamento

No topo da UI existe `Processamento`:

- `CPU`: parse backend em CPU.
- `CUDA (GPU)`: backend tenta usar CUDA nas etapas numericas suportadas.
  - Se CUDA/CuPy nao estiver disponivel, backend faz fallback automatico para CPU e informa no payload.

## Cache backend

- Cache em disco: `.cache/parsed`
- Chave de cache: hash do arquivo + modo efetivo (`cpu`/`cuda`) + versao do parser.
- Cache em RAM (LRU): aloca agressivamente uma fracao da RAM total para reutilizar parse pronto sem reprocessar.

## Como rodar

Na pasta `TESTE`:

```powershell
py -3.9 -m pip install -r requirements.txt
py -3.9 run_cef.py
```

Observacao:
- `run_cef.py` tenta relancar automaticamente em Python 3.9 quando executado em outra versao.
- Ordem de abertura desktop: Google Chrome (`--app`) -> CEF -> Playwright.

Se quiser rodar sem CEF (somente servidor + browser manual):

```powershell
python run_server.py
```

Abrir: `http://127.0.0.1:5173`

## Pacote portatil (sem baixar dependencias na outra maquina)

Agora existe um build portatil que empacota:

- Projeto (`backend`, `frontend`, `run_cef.py`, `run_server.py`)
- Runtime Python 3.9 local completo
- Dependencias ja instaladas no seu Python 3.9 (FastAPI, ezdxf, CuPy, CEF etc)
- Runtime CUDA local (`CUDA v12.0 bin/libnvvp`), quando disponivel

### Gerar pacote portatil

Na pasta `TESTE`:

```powershell
powershell -ExecutionPolicy Bypass -File .\build_portable.ps1
```

Opcional (sem copiar CUDA toolkit):

```powershell
powershell -ExecutionPolicy Bypass -File .\build_portable.ps1 -SkipCuda
```

Saida padrao:

- `TESTE\release-portable`

### Rodar pacote portatil em outra maquina

Na pasta `release-portable`:

- `start_portable.bat`: abre app desktop
- `start_server_portable.bat`: sobe servidor web
- `check_portable_env.bat`: valida runtime Python/CUDA/CuPy/backend

### O que ainda depende da maquina destino

- Driver NVIDIA/Windows precisa existir para CUDA funcionar de fato.
- Sem driver GPU compativel, o app abre e cai automaticamente para modo CPU.
- Nao precisa instalar Python, pip, fastapi, ezdxf, cupy nem CUDA toolkit na maquina destino (ja vao no pacote).

## CUDA opcional

Para habilitar o caminho CUDA de fato, instale CuPy compatível com sua placa/driver (exemplo CUDA 12):

```powershell
pip install cupy-cuda12x
```

Sem CuPy/CUDA, a opcao `CUDA` continua disponivel para teste, mas cai para CPU automaticamente.

## Observacoes de performance

- Parse pesado foi movido para backend.
- Frontend importa via API `/api/parse-dxf`.
- Importacao em lote no frontend agora e paralela (usa os nucleos disponiveis como base de concorrencia).
- Backend usa pool de processos para CPU e CUDA (configuravel), com parse paralelo.
- Modo CUDA tenta empurrar para GPU as etapas numericas (normalizacao vetorial, bounds e vetorizacoes suportadas).
- Fallback de robustez: frontend ainda pode usar texto DXF local apenas se necessario para montagem final.

## Ajuste de "modo bruto" (maximo desempenho)

Variaveis de ambiente opcionais:

- `DXF_CPU_WORKERS`: numero de workers CPU (padrao: total de nucleos logicos).
- `DXF_CUDA_WORKERS`: numero de workers em modo CUDA (padrao: total de nucleos logicos quando CUDA esta disponivel).
- `DXF_CACHE_RAM_FRACTION`: fracao da RAM total reservada para cache em memoria (`0.05` a `0.95`, padrao `0.85`).
- `DXF_CACHE_RAM_MIN_MB`: minimo de cache em RAM em MB (padrao `512`).

Exemplo:

```powershell
$env:DXF_CPU_WORKERS="24"
$env:DXF_CUDA_WORKERS="24"
$env:DXF_CACHE_RAM_FRACTION="0.90"
py -3.9 run_cef.py
```
