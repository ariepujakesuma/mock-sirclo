# Mock Sirclo WA Commerce

Mock server Sirclo untuk development integrasi Connect by Creacon ↔ Sirclo (Nivea WA Commerce), tanpa Jatis/Zanroo. Mengikuti kontrak di **Tech Docs – Nivea API Development & Config v1.0** (Step 1–7).

Node 18+, tanpa dependency.

## Jalankan

```bash
REPLY_URL=http://localhost:3000/sirclo/reply node mock-sirclo.js
```

| Env | Default | Keterangan |
|---|---|---|
| `PORT` | `4010` | Port mock |
| `REPLY_URL` | kosong | Endpoint Creacon BE yang menerima outbound Sirclo. Kosong = hanya di-log |
| `REPLY_TOKEN` | kosong | Bearer token opsional ke `REPLY_URL` |
| `PUBLIC_URL` | `http://localhost:PORT` | Base URL untuk link pembayaran tiruan |

Tes mock sendirian (tanpa Creacon BE): `REPLY_URL=http://localhost:4010/mock/reply`.

## Peran di flow

```
Customer WA ⇄ Meta Cloud API ⇄ Creacon BE ⇄ Mock Sirclo
```

Creacon BE menggantikan posisi Zanroo/Jatis di tech doc, jadi BE harus:

1. **Inbound** — konversi webhook Meta → payload format Infobip (`results[]`), lalu `POST /api/webhook` ke Sirclo.
2. **Outbound** — sediakan endpoint (mis. `POST /sirclo/reply`) yang menerima payload Sirclo, konversi ke format Meta Send Message API, dan balas `{ is_success, process_id, timestamp }`.

## Endpoint

| Method | Path | Fungsi |
|---|---|---|
| POST | `/api/webhook` | Inbound dari Creacon BE (pengganti `middleware-chat.../api/webhook`). Balas 200 tanpa body, sesuai doc |
| POST | `/mock/reply` | Tiruan endpoint reply Creacon BE, untuk tes mandiri |
| GET | `/pay/order?scvCartId=` | Halaman checkout SCV2 tiruan |
| GET | `/mock/outbox` · `/mock/inbox` · `/mock/sessions` | Debug: 100 pesan terakhir & state sesi |
| POST | `/mock/simulate` | Jalankan otomatis Step 1 → 7 dengan pilihan dummy; semua outbound dikirim ke `REPLY_URL` |
| POST | `/mock/reset` | Hapus semua sesi & log |
| GET | `/health` | Health check |

## State machine (per nomor customer)

| Inbound dari BE | `message.type` | Outbound mock | Step doc |
|---|---|---|---|
| Pesan awal / tidak dikenali | apa saja | List kategori | 1 |
| Pilih kategori (`id` = `2_20`…`2_29`) | `INTERACTIVE_LIST_REPLY` | Multi Product (catalog) | 2 → 3 |
| Kirim keranjang | `ORDER` | Reply Button keranjang | 4 → 5 |
| Tombol `getcart.checkout` | `INTERACTIVE_BUTTON_REPLY` | Text + link pembayaran, sesi selesai | 6 → 7 |
| Tombol `getcart.keep_browsing` | `INTERACTIVE_BUTTON_REPLY` | List kategori | 6-alt → 1 |

## Contoh tes (curl)

```bash
W=http://localhost:4010/api/webhook
C=6281337875000   # nomor customer dummy

# Step 1 — pesan awal
curl -X POST $W -H 'Content-Type: application/json' -d '{"results":[{"from":"'$C'","to":"628116621180","message":{"type":"TEXT","text":"start"}}]}'

# Step 2 — pilih kategori Body Care
curl -X POST $W -H 'Content-Type: application/json' -d '{"results":[{"from":"'$C'","to":"628116621180","message":{"type":"INTERACTIVE_LIST_REPLY","id":"2_20","title":"Body Care"}}]}'

# Step 4 — kirim keranjang
curl -X POST $W -H 'Content-Type: application/json' -d '{"results":[{"from":"'$C'","to":"628116621180","message":{"type":"ORDER","catalogId":"384731680916067","productItems":[{"currency":"IDR","itemPrice":19500,"productRetailerId":"13142601250008","quantity":1}]}}]}'

# Step 6 — klik Memesan
curl -X POST $W -H 'Content-Type: application/json' -d '{"results":[{"from":"'$C'","to":"628116621180","message":{"type":"INTERACTIVE_BUTTON_REPLY","id":"getcart.checkout","title":"Memesan"}}]}'

# Lihat semua outbound
curl http://localhost:4010/mock/outbox
```

## Simulasi otomatis

Menjalankan seluruh alur tanpa HP/curl per step: start session → pilih kategori → kirim keranjang → klik Memesan. Setiap outbound dikirim ke `REPLY_URL` dengan jeda `delayMs`.

```bash
# default: customer 6281337875000, kategori Body Care, 1x NIVEA Intensive Lotion, checkout
curl -X POST https://mock-sirclo.unisync.id/mock/simulate

# custom
curl -X POST https://mock-sirclo.unisync.id/mock/simulate -H 'Content-Type: application/json' -d '{
  "customer": "62812xxxxxxx",
  "categoryId": "2_20",
  "items": [{ "currency": "IDR", "itemPrice": 19500, "productRetailerId": "13142601250008", "quantity": 2 }],
  "checkout": true,
  "delayMs": 1500
}'
```

| Field | Default | Keterangan |
|---|---|---|
| `customer` | `6281337875000` | Nomor tujuan. Pakai nomor WA asli untuk melihat pesannya di HP (harus dalam window 24 jam) |
| `categoryId` | `2_20` | ID kategori dari `fixtures.json` |
| `items` | 1x `13142601250008` @ 19.500 | Isi keranjang (format `productItems`) |
| `checkout` | `true` | `false` = klik "Terus Mencari" alih-alih "Memesan" |
| `delayMs` | `1500` | Jeda antar step supaya urutan pesan di WhatsApp tidak tertukar |

Response berisi ringkasan tiap step: payload outbound, `delivered`, dan `status` dari `REPLY_URL`.

## Data dummy (`fixtures.json`)

- Nomor bisnis, `catalogId`, daftar kategori, dan product ID Body Care diambil dari tech doc.
- Kategori selain Body Care belum punya product ID di doc → memakai `defaultProductRetailerIds`. Isi dari katalog Nivea di FBM kalau ingin tes render di WhatsApp sungguhan.
- Nama produk hanya diketahui untuk `13142601250008`; produk lain ditampilkan dengan ID-nya.

## Prinsip: kontrak tech doc tidak diubah

Payload inbound (format Infobip), payload outbound, endpoint, dan expected response mengikuti tech doc apa adanya. Semua translate antara format WhatsApp (Meta) dan format Sirclo dilakukan di Creacon BE lewat `sirclo-adapter.js`:

- `metaToSirclo()` — webhook Meta → payload inbound tech doc (`INTERACTIVE_LIST_REPLY`, `INTERACTIVE_BUTTON_REPLY`, `ORDER`). Tipe pesan yang tidak ada di doc (gambar, audio, lokasi, …) tidak diteruskan.
- `sircloToMeta()` — payload outbound tech doc → Meta Send Message API, isi diteruskan apa adanya tanpa dipotong. Kalau melebihi batas Meta, error dari Meta di-log.

## Batasan & catatan

- **Format data awal (Step 1) tidak ada di doc.** Mock & adapter memakai `TEXT` sementara; konfirmasi ke Sirclo.
- **Format inbound belum pasti.** Tech doc sendiri menyebut payload inbound adalah contoh dari dokumentasi Infobip (Sirclo tidak tahu format aslinya). Konfirmasi ke Sirclo sebelum BE dikunci.
- Contoh Infobip di doc memakai `id: "1"` untuk tombol; mock memakai `getcart.checkout` / `getcart.keep_browsing` sesuai payload outbound Step 5.
- Tidak memvalidasi stok/minimum order, tidak membuat order nyata, tidak ada Xendit. Sesi disimpan di memory (hilang saat restart).
