# Toqan AI — API Reference

**Arquivo:** `toqan-ai-api.md`

> Documentação consolidada dos endpoints da Toqan AI (baseada nos exemplos fornecidos).

---

## Base URL (exemplos)

```
https://api.coco.prod.toqan.ai/api
```

> Observação: nos exemplos que você forneceu as chamadas usam o host `api.coco.prod.toqan.ai/api`. Use esse domínio nas suas integrações, ou substitua pelo `TOQAN_BASE_URL` que você tiver.

---

## Autenticação

A API usa uma chave em header customizado `X-Api-Key` (conforme os exemplos). Inclua em todas as requisições:

```
X-Api-Key: sk_XXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX
```

Opcional: muitos clientes também aceitam `Accept` e `Content-Type`:

```
Accept: */*
Content-Type: application/json
```

Para uploads multipart/form-data use `Content-Type: multipart/form-data` (curl / form-data cuidam do boundary automaticamente).

---

## Endpoints

> Nesta seção estão todos os endpoints que você listou e os exemplos que você forneceu (com pequenas clarificações onde necessário).

---

### 1) Create conversation

* **Método:** `POST`
* **URL:** `/create_conversation`
* **Descrição:** Cria uma nova conversa e envia a primeira mensagem do usuário. Retorna `conversation_id` e `request_id`.

**Exemplo (curl):**

```bash
curl --request POST \
     --url https://api.coco.prod.toqan.ai/api/create_conversation \
     --header 'X-Api-Key: sk_3891a342948aaccc880d9c7d2b3bcafaaf2f7a4fe0d6efd77cc6adc77156f84392b4b690c9e4290349ccb480c845cc98582bd005b46e31f89f00e385eeb1' \
     --header 'accept: */*' \
     --header 'content-type: application/json' \
     --data '\n{\n  "user_message": "hello world"\n}\n'
```

**Exemplo de resposta:**

```json
{
  "conversation_id": "31716779-114b-412e-8510-ac92e6ce42da",
  "request_id": "5385d3af-c56c-43b7-ac13-e455ec897ecf"
}
```

**Uso com arquivos (anexo via `private_user_files`):**

Depois de fazer `PUT /upload_file` e obter `file_id`, é possível criar a conversa referenciando arquivos privados:

```bash
curl --request POST \
     --url https://api.coco.prod.toqan.ai/api/create_conversation \
     --header 'X-Api-Key: sk_...'
     --header 'accept: */*' \
     --header 'content-type: application/json' \
     --data '\n{\n  "user_message": "olha minha imagem",\n  "private_user_files": [\n    { "id": "a65d7ed3-879f-4a50-a9bf-00382f0b4c9d" }\n  ]\n}\n'
```

**Resposta:**

```json
{
  "conversation_id": "70258c03-8458-418d-9db8-c38a097b0197",
  "request_id": "f6419abc-a9ea-4f99-bd00-bcd489419cb9"
}
```

---

### 2) Continue conversation

* **Método:** `POST`
* **URL:** `/continue_conversation`
* **Descrição:** Envia uma nova mensagem do usuário para uma conversa já existente. Retorna `request_id` que você pode usar para buscar/esperar a resposta via `GET /get_answer`.

**Exemplo (curl):**

```bash
curl --request POST \
     --url https://api.coco.prod.toqan.ai/api/continue_conversation \
     --header 'X-Api-Key: sk_3891a342948aaccc880d9c7d2b3bcafaaf2f7a4fe0d6efd77cc6adc77156f84392b4b690c9e4290349ccb480c845cc98582bd005b46e31f89f00e385eeb1' \
     --header 'accept: */*' \
     --header 'content-type: application/json' \
     --data '\n{\n  "conversation_id": "31716779-114b-412e-8510-ac92e6ce42da",\n  "user_message": "hello again"\n}\n'
```

**Exemplo de resposta:**

```json
{
  "conversation_id": "31716779-114b-412e-8510-ac92e6ce42da",
  "request_id": "588692a4-5cd4-4b08-b83d-65a4753c40cd"
}
```

---

### 3) Get answer (polling)

* **Método:** `GET`
* **URL:** `/get_answer`
* **Query params:** `conversation_id` (required), `request_id` (optional — se fornecido, filtra pela requisição específica)
* **Descrição:** Retorna o `status` da resposta e o `answer` quando disponível. **Não há streaming** — deve-se fazer polling até `status` ser `finished` / `done` / equivalente.

**Exemplo (curl):**

```bash
curl --request GET \
     --url 'https://api.coco.prod.toqan.ai/api/get_answer?conversation_id=70258c03-8458-418d-9db8-c38a097b0197&request_id=f6419abc-a9ea-4f99-bd00-bcd489419cb9' \
     --header 'X-Api-Key: sk_...'
     --header 'accept: */*'
```

**Exemplo de resposta (quando finalizado):**

```json
{
  "status": "finished",
  "answer": "Vejo que sua imagem contém informações sobre filas de mensagens (DLQ - Dead Letter Queue) e timestamps. Parece ser um screenshot...",
  "timestamp": "2025-08-09T00:16:29.335Z"
}
```

---

### 4) Find conversation

* **Método:** `POST`
* **URL:** `/find_conversation`
* **Descrição:** Retorna mensagens/metadados da conversa — útil para buscar histórico e anexos.

**Exemplo (curl):**

```bash
curl --request POST \
     --url https://api.coco.prod.toqan.ai/api/find_conversation \
     --header 'X-Api-Key: sk_...' \
     --header 'accept: */*' \
     --header 'content-type: application/json' \
     --data '\n{\n  "conversation_id": "70258c03-8458-418d-9db8-c38a097b0197"\n}\n'
```

**Exemplo de resposta:**

```json
[
  {
    "id": "f6419abc-a9ea-4f99-bd00-bcd489419cb9",
    "type": "message",
    "timestamp": "2025-08-09T00:16:14.94Z",
    "message": "olha minha imagem",
    "author_id": "apikey_000000D8sswKjSbo7iMsi8QRJD7GV",
    "attachments": [
      { "name": "Screenshot%202025-07-28%20at%2015.08.16.png", "mime_type": "image/png" }
    ]
  },
  {
    "id": "3759615973053143803",
    "type": "message",
    "timestamp": "2025-08-09T00:16:20.234Z",
    "message": "<think>...vou usar OCR...</think>\n\nVou analisar sua imagem para você.",
    "author_id": "Toqan"
  },
  {
    "id": "5051706978395567352",
    "type": "message",
    "timestamp": "2025-08-09T00:16:29.335Z",
    "message": "Vejo que sua imagem contém informações sobre filas...",
    "author_id": "Toqan"
  }
]
```

---

### 5) Upload file

* **Método:** `PUT`
* **URL:** `/upload_file`
* **Descrição:** Faz upload de um arquivo (multipart/form-data). Retorna `file_id` que pode ser usado em `private_user_files` ao criar/continuar conversas.

**Exemplo (curl):**

```bash
curl --request PUT \
     --url https://api.coco.prod.toqan.ai/api/upload_file \
     --header 'X-Api-Key: sk_...' \
     --header 'accept: application/json' \
     --header 'content-type: multipart/form-data' \
     --form file='@Screenshot%202025-07-28%20at%2015.08.16.png'
```

**Exemplo de resposta:**

```json
{
  "file_id": "a65d7ed3-879f-4a50-a9bf-00382f0b4c9d"
}
```

---

### 6) Download file

* **Método:** `GET`
* **URL:** `/download_file`
* **Query params (exemplo):** `conversation_id`, `file_name`
* **Descrição:** Baixa o conteúdo binário do arquivo associado a uma conversa (ex.: imagem). O retorno é `application/octet-stream` / binário.

**Exemplo (curl):**

```bash
curl --request GET \
     --url 'https://api.coco.prod.toqan.ai/api/download_file?conversation_id=5a4731d8-b6da-4e62-9c11-66f755933391&file_name=a.png' \
     --header 'X-Api-Key: sk_...' \
     --header 'accept: application/octet-stream'
```

**Exemplo de resposta:**

> Conteúdo binário (PNG / JPEG / etc.). No `curl` você verá bytes começando com o cabeçalho do arquivo (ex.: `\x89PNG...`).

---

## Fluxo típico (resumo)

1. `PUT /upload_file` (se houver arquivos locais) → obter `file_id`.
2. `POST /create_conversation` (envia `user_message` e opcionalmente `private_user_files: [{ id: "..." }]`) → recebe `conversation_id` e `request_id`.
3. Opcionalmente, para mensagens subsequentes: `POST /continue_conversation` (passando `conversation_id`) → recebe novo `request_id`.
4. Polling: `GET /get_answer?conversation_id=...&request_id=...` até `status` indicar finalização; resposta em `answer`.
5. `POST /find_conversation` pode retornar histórico e attachments.
6. `GET /download_file` para baixar anexos quando necessário.

---

## Observações e dicas de integração

* **Sem streaming nativo:** a API não fornece SSE/streams — o padrão é `create/continue` + `get_answer` polling.
* **IDs importantes:** `conversation_id` (sessão), `request_id` (cada envio que gera uma resposta), `file_id` (arquivos enviados).
* **Headers:** use sempre `X-Api-Key`. Se você criar um proxy/bridge para Anthropic (como discutido), aceite `ANTHROPIC_*` no lado do cliente e traduza para `X-Api-Key` quando chamar Toqan.
* **Timeouts & polling:** implemente um tempo limite (ex.: 30s) e intervalos exponenciais/fixos para polling de `get_answer`.
* **Segurança:** trate `X-Api-Key` com cuidado (não logar em texto claro). Ao expor um bridge, valide e limite o uso (rate limiting, CORS, autenticação adicional) para proteger a chave upstream.

---

## Histórico / fonte dos exemplos

Os exemplos neste documento foram extraídos da conversa fornecida pelo usuário (cURLs e respostas JSON/Binárias) e organizados para referência técnica.

---

*Fim do documento.*
