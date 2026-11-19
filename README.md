# HTML to MP4 — Android Studio & Offline Web Converter

A mobile-first HTML animation (Canvas, CSS, SVG, WebAudio) to MP4 converter running **100% offline** on Android with deterministic virtual-clock rendering, `OfflineAudioContext` audio mixing, WebCodecs + native `MediaCodec` H.264/AAC encoding, and a real-time `MediaRecorder` fallback.

## Project Structure

- `app/` — Native Android Kotlin + Jetpack Compose application wrapping the offline converter engine:
  - `app/src/main/assets/web/` — Self-contained offline web app & modules (no CDN links).
  - `app/src/main/java/com/example/StudioWebViewHost.kt` — Secure HTTPS virtual-origin WebView host with `<input type="file">` chooser, keep-awake, progress notification, and native `MediaStore` / `FileProvider` bridges.
  - `app/src/main/java/com/example/NativeMediaCodecEncoder.kt` — High-speed hardware/software `MediaCodec` + `MediaMuxer` fallback when a device WebView lacks WebCodecs H.264.
  - `app/src/main/java/com/example/RenderProgressNotifier.kt` — Live notification bar progress while rendering.
- `capacitor.config.ts` & `package.json` — Capacitor metadata (`appId: com.example.htmlvideo`, `appName: HTML to Video`, `webDir: dist`) and web bundle script (`npm run build`).
- `.github/workflows/build-apk.yml` — Automated GitHub Actions workflow producing the `app-debug` APK artifact.

## Build & Install Debug APK

### Option 1: GitHub Actions (Automatic)
1. Push this repository to the `main` branch (or trigger **Actions → Build Android Debug APK → Run workflow**).
2. Download the **`app-debug`** artifact (`app-debug.apk`) from the completed workflow run.
3. Transfer `app-debug.apk` to your Android phone and open it to install (allow **Install unknown apps** if prompted).

### Option 2: Build Locally with Gradle
Requirements: **JDK 17+**, **Android SDK (API 36)**, and **Gradle 9.3.1** (or Android Studio).

```bash
# 1. (Optional) Build the offline web distribution into dist/
npm run build

# 2. Build the debug APK
gradle assembleDebug
```

The APK will be generated at:
`app/build/outputs/apk/debug/app-debug.apk`

Install onto a connected device via ADB:
```bash
adb install -r app/build/outputs/apk/debug/app-debug.apk
```
