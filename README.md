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

### 12.1 Protocolo obrigatorio (olhar, ver, analisar e so depois corrigir)

Para qualquer bug de geometria, seguir sempre:
1. olhar o resultado no viewer e comparar com o CAD de referencia (ex.: FreeCAD)
2. verificar se o erro esta no contorno externo, nos furos, na hierarquia ou no fallback
3. analisar os dados reais do DXF (tipos de entidade, loops fechados, areas, depth pai/filho)
4. formular hipotese tecnica com base nos dados (nao em tentativa aleatoria)
5. testar a hipotese no arquivo problematico e em arquivos de controle
6. aplicar a menor correcao possivel, localizada no ponto da causa raiz
7. validar novamente no arquivo original e em casos ja resolvidos (anti-regressao)
8. documentar no README: sintoma, causa raiz, correcao e commit

Regras de decisao:
- se nao reproduziu, nao alterar regra global
- se nao mediu, nao concluir causa
- se nao validou em mais de um arquivo, nao considerar resolvido

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
- Erro `Falha ao converter ... no servidor (501)`:
  - isso ocorre quando esta rodando apenas servidor estatico sem API
  - o app agora troca automaticamente para `Atual (Browser DXF)` para nao bloquear importacao

## 16. Casos resolvidos

### Caso A - Painel perfurado preenchendo lado interno (ex.: `210921`)

- Sintoma:
  - parte interna do painel aparecia \"pintada\" em um lado, enquanto no FreeCAD os furos estavam corretos
- Causa raiz:
  - varios furos vieram como loop composto/auto-intersectante (duas voltas no mesmo caminho), gerando triangulacao invalida
- Correcao:
  - normalizacao de loop composto em `buildShapesFromClosedLoops(...)` via `splitCompoundLoopCandidates(...)`
  - deduplicacao por centro de furo para manter uma representacao valida por cavidade
- Resultado:
  - furos passaram a ser reconhecidos corretamente dos dois lados, sem preenchimento falso
- Commit:
  - `d7ceece`

### Caso B - Barra curva gerando chapa falsa preenchida (peca `212376`)

- Sintoma:
  - geometria correta no FreeCAD, mas no viewer aparecia uma shape grande preenchida por cima da peca curva
- Causa raiz:
  - `hull fallback` adicionava um contorno convexo extra, mesmo ja existindo contorno pai valido com furos internos
- Correcao:
  - guarda de `hull fallback` com deteccao de \"strong container contour\" antes de criar hull
- Resultado:
  - peca passou a sair com 1 shape valida + furos, sem overlay preenchido
- Commit:
  - `291da5c`

### Caso C - Pecas com `LINE/ARC` e furos pequenos (ex.: `212414`, `212541`, `212232`, `212336`)

- Sintoma:
  - contorno/furos inconsistentes dependendo da regiao da peca
- Causa raiz:
  - export CAD com combinacao de contornos abertos + loops internos duplicados
- Correcao:
  - reparse em modo bruto `LINE/ARC` quando detectado padrao de chapa
  - normalizacao de pseudo-containers e ajuste de hierarquia contorno/furo
- Resultado:
  - importacao consistente dessas pecas, com furos e bordas preservados
- Commit:
  - `d7ceece`

## 17. Modo A/B no frontend (Atual x Nova arquitetura)

No topo da tela existe `Modo importacao` com duas opcoes:

- `Atual (DXF no navegador)`:
  - usa o pipeline JS atual (`dxf-worker.js` + fallback `dxf-parser`)
- `Nova (EZDXF + GLB servidor)`:
  - envia o arquivo DXF para o backend
  - backend retorna GLB pronto
  - frontend apenas carrega o GLB no viewer atual

Objetivo:
- comparar qualidade/geometria e desempenho entre os dois fluxos no mesmo viewer.

Comportamento de seguranca:
- se o endpoint de servidor nao existir (ex.: servidor estatico `python -m http.server`),
  o frontend detecta status como `404/405/501` ou resposta HTML e volta automaticamente
  para `Atual (Browser DXF)`.

## 18. Backend recomendado (EZDXF + cache GLB)

Arquitetura recomendada:
1. usar `ezdxf` para parse + healing do DXF
2. gerar malha 3D e exportar `GLB` no servidor
3. cachear por hash de entrada (`dxf + espessura + versao do pipeline`)
4. opcional: gerar JSON com metadados 2D (contornos/furos) para selecao avancada

### 18.1 Endpoint esperado pelo frontend

`POST /api/convert-dxf-glb` (multipart/form-data):
- `file`: arquivo `.dxf`
- `thickness`: espessura em Z

Respostas aceitas pelo frontend:

1. Binario GLB direto:
- `Content-Type: model/gltf-binary`
- corpo = bytes do `.glb`

2. JSON:
- `glbBase64`: GLB em base64
ou
- `glbUrl`: URL para download do GLB

Campos opcionais:
- `warnings`: lista de avisos
- `meta2d`: metadados 2D (contorno/furos), quando quiser suportar selecao avancada por dados CAD
