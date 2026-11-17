# Monitor de preços (Kabum, Amazon, Magalu, Mercado Livre, Shopee)

Monitora anúncios 24/7, guarda o histórico de preço, calcula o **menor preço efetivo** (Pix, cupom, cashback) e avisa no Telegram.

## O que ele faz

- **Verifica** cada anúncio periodicamente (padrão: 10 min, com variação aleatória).
- **Calcula o preço efetivo**: preço → melhor cupom aplicável (cupons da própria página, cupons de canais de promoção, cupons manuais) → Pix → cashback (opcional).
- **Mostra a confiança** de cada cupom: 🟢 confirmado (está na página), 🟡 provável, ⚪ não verificado.
- **Alerta** quando o preço atinge o seu alvo, quando é o menor já registrado, ou quando fica bem abaixo da mediana dos últimos 30 dias. Não repete o mesmo alerta à toa.
- **Painel web** com gráfico do histórico por loja.
- **Bot do Telegram** para cadastrar produtos e anúncios, definir alvos, cadastrar cupons e colar mensagens de promoção.

## Preparação

1. **Bot do Telegram**: fale com [@BotFather](https://t.me/BotFather), crie o bot e copie o token. Depois mande uma mensagem para ele e descubra seu `chat id` (ex.: pelo bot `@userinfobot`).
2. **Mercado Livre (recomendado)**: crie um app em developers.mercadolivre.com.br e copie `Client ID` e `Client Secret`. Sem isso, o Mercado Livre costuma bloquear a leitura da página.
3. **Leitor de canais de promoção (opcional)**: em my.telegram.org, crie um app para obter `API ID` e `API hash`. Depois rode `npm run telegram:login` para gerar a `TELEGRAM_SESSION`.
4. **Claude (opcional)**: com `ANTHROPIC_API_KEY`, mensagens de promoção são interpretadas por IA (modelo `claude-haiku-5-5`, configurável em `ANTHROPIC_MODEL`). Sem a chave, usa-se só o leitor de texto.

## Configuração

```bash
cp .env.example .env   # e preencha os valores
```

Regras por loja (Pix extra que a página não mostra, cashback que você recebe) ficam em `config/lojas.json`.
Em `.env`, `USER_FIRST_PURCHASE=true` libera os cupons de primeira compra no cálculo, e `USER_AMAZON_PRIME=true` libera os cupons "Exclusivo Prime" da Amazon.

A faixa de preço do produto (`/faixa`) vale também para as mensagens dos canais de promoção: se o preço anunciado estiver fora dela, o aviso não é enviado. Mensagens sem preço legível continuam sendo avisadas.

**Grupos e canais do Telegram:** em `TELEGRAM_PROMO_CHANNELS` você pode colocar grupos privados pelo ID, além de canais por @nome. Para listar os seus grupos com o ID de cada um, rode `npm run telegram:chats`. Mensagens de conversa comum (sem preço, cupom ou link de loja) são ignoradas, e a mesma oferta vinda de vários grupos é avisada uma vez por dia.

## Rodando

Local (Node 22.13+ ou 24):

```bash
npm install
npx playwright install chromium
npm start
```

Na VPS (Docker):

```bash
docker compose up -d --build
docker compose logs -f
```

Painel: `http://IP-DA-VPS:8080` (usuário e senha definidos em `WEB_USER` e `WEB_PASSWORD`). Para acesso pela internet, recomendo um proxy com HTTPS (Caddy ou Nginx) na frente.

## Comandos do bot

| Comando | Função |
|---|---|
| `/novo <nome>` | cria um produto |
| `/link <id> <url>` | adiciona um anúncio e já verifica |
| `/alvo <id> <valor>` | preço-alvo, ex.: `/alvo 1 350` |
| `/palavras <id> dualsense -edge` | filtro para mensagens de canais |
| `/lista` · `/historico <id>` · `/check <id>` | consultas |
| `/cupom <texto>` | cadastra um cupom ou cola uma mensagem de promoção |
| `/cupons` | cupons ativos |
| `/remover <id>` | remove um produto |

## Testes

```bash
npm test                 # testes unitários (parsers, preço efetivo, alertas)
node test/e2e-smoke.mjs  # teste com as lojas reais (precisa de internet)
npm run check            # verifica todos os anúncios agora, sem bot
```

## Limitações conhecidas

- Magalu e Mercado Livre bloqueiam acesso automatizado com frequência. Para o Mercado Livre, use a API (acima). A Magalu pode falhar da VPS; o sistema avisa após 5 falhas seguidas.
- Seletores de página mudam. Se uma loja parar de funcionar, os testes com `test/fixtures` mostram onde ajustar.
- Cupons de canais sem loja identificada entram como "qualquer loja" com confiança ⚪ e não alteram o preço por padrão.
- Só monitore preços para uso pessoal e em frequência moderada, respeitando os termos de cada loja.
