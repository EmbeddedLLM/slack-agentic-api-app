# Files and knowledge bases

A file attached to a Slack request and a shared search corpus have different lifetimes. Ordinary Slack uploads are not automatically added to the shared knowledge base.

## Attach a file to a request

The bridge downloads an authorized Slack attachment, extracts bounded text, and sends it as native Responses `input_file` content over WebSocket:

```json
{"type":"input_file","filename":"notes.txt","file_data":"data:text/plain;base64,aGk="}
```

This is enabled by `AGENTIC_NATIVE_FILE_INPUTS=true`. Set it to `false` for the previous prompt-text representation. Both modes use `ATTACHMENT_CHAR_BUDGET`; truncation is disclosed. Images use `input_image` data URLs and require a vision-capable model.

The current gateway's direct Responses input supports inline UTF-8 text files. It rejects file-ID/URL references and binary PDF/Office input in this path. The bridge therefore extracts Office/PDF text with optional `officeparser` and sends an extracted `.txt` file; it does not pretend to pass binary PDFs directly to the model. Extracted document images can accompany the text.

## Create a shared knowledge base

As in the Agentic API playground, documents are uploaded through `/v1/files` and ingested into a vector store. These administration endpoints use HTTP; inference and `file_search` execution still use the Responses WebSocket.

```bash
npm run knowledge -- create "Team handbook" ./handbook.md
```

The command prints an ingested vector-store ID. Add another document with:

```bash
npm run knowledge -- add vs_YOUR_STORE ./onboarding.txt
```

Enable access for a role in `access.json`:

```json
{
  "roles": {
    "member": {
      "tools": "web_search,file_search",
      "vectorStoreIds": ["vs_YOUR_STORE"],
      "readUploads": true,
      "createFiles": true
    }
  }
}
```

Merge this into your existing policy. The operator chooses store IDs; a Slack prompt cannot add a store to its permissions. Alternatively, `AGENTIC_VECTOR_STORE_IDS` supplies defaults for roles that do not override `vectorStoreIds`. Adding or removing store permissions starts a separate chat-memory chain.

The tool declares `vector_store_ids` and `max_num_results:5`, and requests `file_search_call.results`. Answers translate typed file citations into readable filenames. Retrieved passages are treated as evidence, not instructions.

## Gateway storage

Without an embedding endpoint, the gateway uses keyword retrieval. An embedding service is optional for semantic/hybrid search. Configure it on the gateway; the Slack app does not manage embedding credentials.

The app's source build enables `file-search-pdf` for text-bearing PDF ingestion. Office documents should be converted to text before shared-corpus ingestion. Scanned PDFs need OCR first. Files API uploads and vector-store ingestion have separate limits; a stored binary upload is not necessarily searchable.

Keep the gateway database and its file-storage directory together when backing up or moving the installation. Removing local Slack upload files does not erase persisted gateway history or knowledge-base files. Uploads created before a failed ingestion remain on the gateway; the CLI prints their IDs so you can inspect or delete them using the Files API.

See the [upstream file-search guide](https://github.com/vllm-project/agentic-api/blob/main/docs/api/file-search.md) for embeddings, limits, retrieval modes and deletion.
