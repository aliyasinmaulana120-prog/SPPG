# SPPG + HGWC (Hand Gesture Website Control)

Paket ini mempertahankan website SPPG dari source ZIP yang diberikan dan menambahkan modul HGWC.

## Cara hosting
1. Ekstrak isi folder `SPPG-main` ke document root hosting (misalnya `public_html/`).
2. Pastikan `index.html`, `sw.js`, `manifest.json`, folder `icons/`, dan folder `assets/` berada pada struktur yang sama.
3. Hosting wajib menggunakan HTTPS untuk akses kamera.
4. Buka website, izinkan kamera, lalu tekan tombol **VISION** di kanan bawah dan pilih **Aktifkan kamera**.
5. Model MediaPipe diunduh dari CDN saat pertama kali vision engine dijalankan; koneksi internet diperlukan pada pemuatan pertama.

## Kontrol
- Telunjuk: menggerakkan pointer.
- Pinch ibu jari + telunjuk: klik.
- Pinch ditahan: drag untuk elemen yang memang ditandai/diimplementasikan sebagai draggable.
- Telunjuk + jari tengah: mode scroll.
- Telapak terbuka selama 2 detik: Emergency Stop.
- Virtual keyboard: otomatis saat input teks difokuskan (dapat dimatikan), atau melalui tombol panel.

## Kamera bersama
Scanner QR/barcode dan HGWC memakai `SPPGCameraManager`. Hanya satu modul yang memegang kamera pada satu waktu. Ketika scanner dibuka, HGWC dihentikan untuk melepas kamera. Setelah scanner ditutup, pengguna dapat mengaktifkan HGWC kembali secara manual.

## Catatan implementasi
- Aktivasi otomatis hanya berjalan jika pengguna mengaktifkannya di pengaturan dan browser sudah menyatakan izin kamera `granted`. Browser mungkin tidak mendukung Permissions API untuk kamera; dalam kondisi itu gunakan aktivasi manual.
- Semua pemrosesan frame dilakukan di browser. Video tidak dikirim ke server.
- Perintah JavaScript tidak dapat menggantikan trusted user activation untuk semua dialog sistem/browser, misalnya file picker atau izin clipboard.
- Virtual keyboard V1 mendukung input teks dan textarea standar. Komponen custom/editor khusus mungkin memerlukan adapter tambahan.
- Drag hanya diaktifkan untuk elemen draggable yang dikenali. Tidak semua komponen simulasi otomatis mendukung drag.
- Periksa kebijakan CSP hosting jika CDN MediaPipe diblokir.
- Pengujian staging wajib dilakukan sebelum mengganti website produksi.

## Struktur tambahan
- `assets/css/vision-control.css`
- `assets/js/vision/camera-manager.js`
- `assets/js/vision/hand-detector.js`
- `assets/js/vision/vision-app.js`
- `README-HGWC.txt`
