# Plantão de Leads: check-in facial + distribuição no RD Station CRM

Substitui a folha de papel da recepção. O corretor chega, olha para o tablet e
pisca. O sistema reconhece o rosto, registra o check-in e ele passa a receber
leads do RD Station CRM em rodízio até o fim do turno.

## Regras de negócio (padrão, editáveis no painel)

| Turno | Janela de check-in | Apto a receber leads |
|---|---|---|
| Manhã | 09:30 – 09:59 | do check-in até 14:00 |
| Tarde | 14:00 – 14:59 | do check-in até 19:00 |

- Às 14:00 todos saem do plantão. Quem quiser receber leads à tarde precisa
  renovar o check-in entre 14:00 e 14:59.
- Quem perdeu a manhã pode entrar na tarde.
- Funciona de segunda a sábado (configurável).
- **Rodízio justo:** o lead vai para quem recebeu menos no turno. No empate, vai
  para quem está há mais tempo sem receber e, depois, para quem chegou primeiro.
- **Ninguém apto:** o lead vai para o responsável reserva (`RD_FALLBACK_OWNER_ID`,
  por exemplo o gerente).

## Arquitetura

```
Tablet (navegador, modo quiosque)
  face-api roda NO APARELHO → gera descritor (128 números) + prova de vida (piscada)
        │  POST /api/kiosk/checkin (token do tablet)
        ▼
Servidor Node.js (Express + SQLite embutido)
  ├─ motor de regras de horário (src/domain/schedule.js)
  ├─ reconhecimento: compara descritores (src/domain/faceMatch.js)
  ├─ rodízio (src/domain/distribution.js)
  └─ painel do gestor (/admin)
        ▲  POST /api/webhooks/rd/<segredo>  (nova negociação no RD)
        │
RD Station CRM ◄── PUT /deals/{id} owner_id  (troca o responsável)
```

- **Nenhuma foto é armazenada.** Só o descritor numérico, que não permite
  reconstruir a imagem.
- **Consentimento LGPD** é obrigatório no cadastro facial e fica registrado com
  data (`consent_at`). A biometria pode ser apagada pelo painel a qualquer momento.
- **Contingência:** o gerente pode fazer check-in manual com motivo obrigatório.
  Isso fica no relatório e no log de auditoria.
- **Idempotência:** se o RD reenviar o mesmo webhook, o lead não é redistribuído.
  Só se a tentativa anterior tiver falhado.

## Modo demonstração (para apresentar à empresa)

Com `DEMO_MODE=true`:
- o check-in fica **aberto em qualquer horário** (apresentação às 16h funciona);
- **nada é enviado ao RD**, e a simulação é forçada mesmo que haja token;
- o painel ganha os botões **"Gerar dados de exemplo"** (12 corretores fictícios,
  3 gerentes e 10 dias de histórico) e **"Apagar dados de exemplo"**.

Roteiro sugerido para a reunião:
1. Gere os dados de exemplo e mostre o painel cheio e o relatório no Excel.
2. Cadastre o rosto de alguém da diretoria na hora.
3. Essa pessoa faz o check-in no tablet, e o painel mostra "apto" na hora.
4. Clique em "Simular lead" e mostre o rodízio.

Prints: [painel](docs/prints/demo-agora.png) · [relatório](docs/prints/demo-relatorio.png)

## Publicar para teste (HTTPS)

O projeto tem `Dockerfile`. Qualquer hospedagem com **disco persistente**
montado em `/data` serve:
- **Railway:** New Project → Deploy from GitHub → adicione um Volume em `/data`
  e as variáveis do `.env.example` (com `DEMO_MODE=true`).
- **Render / Fly.io:** o mesmo processo, com um disco persistente.

Sem disco persistente, os cadastros somem a cada reinício.

## Rodando

Requisitos: Node.js 22.13 ou superior.

```bash
npm install
cp .env.example .env        # preencha os segredos
set -a; . ./.env; set +a
npm start                   # http://localhost:3000
npm test                    # testes automatizados
```

- `/kiosk`: abrir no tablet (Chrome → "Adicionar à tela inicial"; depois,
  fixação de tela do Android ou um app de quiosque). Na primeira vez, informe o
  `KIOSK_TOKEN`.
- `/admin`: painel do gestor (senha `ADMIN_PASSWORD`).

A câmera só funciona em **HTTPS** (ou `localhost`). Em produção, publique atrás
de HTTPS (Railway, Render, Fly.io, VPS com Caddy etc.) com disco persistente
para o `DB_PATH`.

## Integração com o RD Station CRM: passo a passo

1. **Comece em modo simulação** (`RD_DRY_RUN=true`, o padrão). O sistema
   decide o corretor e mostra no painel, mas não altera nada no RD.
2. No painel, cadastre cada corretor com o **ID do usuário no RD**.
3. No RD CRM, crie um **webhook de negociação criada** apontando para
   `https://SEU-DOMINIO/api/webhooks/rd/<RD_WEBHOOK_SECRET>`.
4. Gere o token de API e preencha `RD_ACCESS_TOKEN`.
5. **Valide o formato da chamada** em `src/integrations/rdCrm.js` com a
   [documentação oficial](https://developers.rdstation.com/reference/crm-v2-update-deal).
   Estão assumidos o corpo `{ data: { owner_id } }` e a autenticação Bearer.
   Tudo que depende do RD está isolado nesse arquivo.
6. **Desligue a distribuição nativa** do RD para as duas regras não disputarem
   o mesmo lead. Só então use `RD_DRY_RUN=false`.

## Estrutura

```
src/
  domain/        regras puras (horários, reconhecimento, rodízio), 100% testadas
  integrations/  cliente do RD Station CRM
  services.js    casos de uso (check-in, distribuição)
  app.js         rotas HTTP, validação, segurança
  db.js          SQLite (node:sqlite) e consultas
public/
  kiosk.html     tela do tablet
  admin.html     painel do gestor
  js/face.js     reconhecimento facial + prova de vida
test/            testes de unidade e de ponta a ponta da API
```

## Próximos passos sugeridos

- Pilotar uma semana em paralelo com o papel e medir a taxa de reconhecimento.
- Alerta no WhatsApp do corretor quando o lead chegar e lembrete às 13:50
  ("renove seu check-in").
- Multiempresa (para vender a outras imobiliárias) e rodízio por equipe/gerente.
- Migrar o SQLite para Postgres quando houver mais de uma unidade ou tablet.
