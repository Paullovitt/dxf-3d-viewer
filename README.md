# DXF 3D Viewer

Visualizador/importador de pecas DXF em 3D (Three.js), focado em arquivos CNC com geometria mista (`LWPOLYLINE`, `POLYLINE`, `LINE`, `ARC`, `CIRCLE`, `SPLINE`) e correcoes para DXF imperfeito.

## 1. Objetivo

Este projeto importa DXFs 2D, reconstrui contornos validos (borda + furos) e gera malhas 3D extrudadas.

Prioridades do projeto:
- fidelidade de contorno (evitar preencher furo por erro de loop)
- robustez para arquivos CAD "sujos"
- desempenho aceitavel para chapas com muitos furos

## 2. Requisitos

- Navegador moderno com suporte a ES Modules e Web Workers.
- Servidor HTTP local (nao abrir `index.html` via `file://`).

## 3. Bibliotecas e APIs usadas

Bibliotecas externas:
- `three@0.160.0` via importmap (`index.html`)
- `OrbitControls` e `TransformControls` (addons do Three)
- `dxf-parser@1.1.2` via `esm.sh` (fallback de parse)

APIs nativas do browser:
- `Web Worker` para parse em paralelo (`dxf-worker.js`)
- `FileReader` / `TextDecoder` para leitura dos arquivos
- WebGL via `THREE.WebGLRenderer`

## 4. Como executar

Na pasta do projeto:

```bash
python -m http.server 5173
```

Abrir:

`http://127.0.0.1:5173`

Observacao: apos atualizar `app.js`, use `Ctrl + F5` para evitar cache antigo.

## 5. Fluxo de execucao (alto nivel)

1. Usuario seleciona um ou varios DXFs.
2. Arquivo e decodificado (`utf-8` com fallback `utf-16le` e `latin1`).
3. Parse preliminar no worker (`parseDxfAsciiCnc` em `dxf-worker.js`).
4. Import principal em `importWithCncContours(...)` (`app.js`).
5. Reconstrucao de loops fechados + hierarquia contorno/furo.
6. Geracao de `THREE.Shape` e extrusao (`THREE.ExtrudeGeometry`).
7. Adicao da peca na cena + layout automatico + cache de bounds.

Fallback:
- Se o fluxo principal falhar, entra `dxf-parser` (CDN) e aplica mesma logica de fechamento/reparo no `app.js`.

## 6. Pipeline DXF detalhado

### 6.1 Parse ASCII CNC (worker)

Arquivo: `dxf-worker.js`

- Le entidades na secao `ENTITIES`.
- Converte:
  - `LINE` -> segmento aberto
  - `ARC` -> polilinha discretizada
  - `CIRCLE` -> loop fechado
  - `LWPOLYLINE`/`POLYLINE` -> pontos com suporte a `bulge`
  - `SPLINE` -> aproximacao por pontos
- Limpa ruido (`cleanImportedContoursCnc`) com:
  - deduplicacao de pontos consecutivos
  - remocao de contornos degenerados
  - stitch de contornos abertos por tolerancia
  - filtragem de grupos desconectados irrelevantes
- Normaliza coordenadas para origem local (minX/minY).

### 6.2 Reconstrucao de loops (app)

Arquivo: `app.js`

Funcoes centrais:
- `extractClosedLoopsFromSegments(...)`
- `stitchClosedLoopsFromOpenContours(...)`
- `findDominantOuterLoopFromOpenContours(...)`
- `buildShapesFromClosedLoops(...)`

Tolerancias progressivas de fechamento por segmentos:
- `1e-4`
- `1e-2`
- `5e-2`

### 6.3 Reparse para modo bruto LINE/ARC

Quando o padrao indica chapa com muitos abertos e poucos fechados grandes,
o import reprocessa com `preferSimple: true` para preservar geometria.

## 7. Regras geometricas e correcoes aplicadas

### 7.1 Hierarquia contorno x furo

- Cada loop recebe pai/filho por inclusao geometrica (bbox + point-in-polygon estrito).
- Profundidade par = contorno externo.
- Profundidade impar = furo.

### 7.2 Pseudo-furo (container duplicado)

Caso comum de export CAD:
- borda duplicada interna muito grande + varios furos pequenos.

Tratamento:
- o container duplicado e marcado para skip
- netos (furos reais) sao promovidos ao pai correto

### 7.3 Chapa perfurada densa

Deteccao de padrao denso:
- escolhe maior contorno como possivel borda
- coleta candidatos de furos internos pequenos
- deduplica por celula de centro
- monta `Shape` com 1 borda + N furos

### 7.4 Correcao de loop composto (causa raiz do preenchimento indevido)

Problema real identificado:
- alguns furos vinham como loop composto (duas voltas no mesmo caminho,
  com pontos repetidos e auto-intersecao).
- triangulacao desses loops podia preencher trechos internos errados.

Correcao aplicada:
- `splitCompoundLoopCandidates(...)` em `buildShapesFromClosedLoops(...)`
- detecta loop suspeito por:
  - repeticao nao adjacente de ponto
  - `area/bbox` fora de faixa valida
- explode o loop em subloops via segmentos
- deduplica por centro de furo e preserva so a melhor representacao

Resultado:
- furos internos passam a ser tratados como furos em ambos os lados da chapa
- evita "mancha preenchida" parcial em paineis perfurados

### 7.5 Filtro de overlay interno artefato

Mesmo apos hierarquia, se houver shape interno com baixa densidade de furos,
contido no shape dominante perfurado, ele e descartado como artefato.

### 7.6 Guarda para pecas longas/curvas (evitar hull falso)

Problema observado em pecas tipo barra curva (ex.: `212376`):
- o `hull fallback` podia adicionar um contorno convexo extra
- isso gerava uma shape falsa preenchida por cima da peca real

Correcao aplicada:
- antes de adicionar hull, o algoritmo detecta se ja existe contorno pai forte
  contendo os demais loops internos (furos)
- se esse contorno forte existe, o hull nao e criado

Resultado:
- peca curva mantem apenas a shape valida (borda + furos)
- evita \"triangulo/chapa\" preenchida indevida em geometrias esbeltas

## 8. Selecao, edicao e atalhos

- Clique: seleciona peca.
- Gizmo (`TransformControls`): mover peca selecionada.
- `Delete`/`Backspace`: excluir peca selecionada.
- `Esc`: limpar selecao.

A borda de selecao e calculada a partir dos shapes finais (nao de loops crus),
evita highlight desalinhado.

## 9. Layout automatico de multiplas pecas

As pecas entram em grade no quadrante superior (X/Y), com camadas negativas em Z
quando necessario, para reduzir sobreposicao.

## 10. Performance

Melhorias implementadas:
- parse em worker pool (`navigator.hardwareConcurrency`)
- reducao adaptativa de `curveSegments` conforme quantidade de furos
- filtros para remover loops/overlays espurios antes da extrusao

Efeito esperado:
- menos travamento em chapas com centenas/milhares de furos
- menor custo de triangulacao desnecessaria

## 11. Avisos e mensagens de importacao

O sistema avisa quando:
- nao encontra entidade fechada valida
- fecha contornos abertos automaticamente
- um arquivo do lote foi ignorado

No lote, os avisos sao agregados em resumo unico para reduzir popups.

## 12. Estrategia de diagnostico (padrao do projeto)

Antes de alterar regra:
1. reproduzir com DXF real do usuario
2. medir dados (quantidade de loops, depth, area, distribuicao por lado)
3. identificar causa geometrica especifica
4. aplicar correcao pontual e validar em outros DXFs

Regra: evitar ajuste por chute.

## 13. Estrutura de arquivos

- `index.html`: shell da UI + importmap + cache-bust de script.
- `styles.css`: tema e layout visual.
- `app.js`: cena, interacao, pipeline de importacao e fallback.
- `dxf-worker.js`: parser ASCII CNC em worker.

## 14. Publicacao no GitHub (fluxo rapido)

```bash
git add app.js index.html README.md
git commit -m "Fix DXF perforated holes normalization and document full pipeline"
git push origin main
```

Se houver erro de autenticacao no push, configurar credencial/token do GitHub no ambiente local.

## 15. Troubleshooting

- Geometria antiga no navegador:
  - `Ctrl + F5`
- Import falhando:
  - abrir `F12` e conferir tipos de entidade detectados
- Pecas sobrepostas:
  - usar `Enquadrar (Fit)` e verificar `Centro automatico`
- DXF com canto/furo estranho:
  - validar se veio em `LINE/ARC` aberto e revisar logs de stitch/hierarquia
