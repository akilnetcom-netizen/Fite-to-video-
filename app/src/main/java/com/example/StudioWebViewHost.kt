package com.example

import android.annotation.SuppressLint
import android.content.Context
import android.net.Uri
import android.view.ViewGroup
import android.webkit.JavascriptInterface
import android.webkit.ValueCallback
import android.webkit.WebChromeClient
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.viewinterop.AndroidView
import java.io.ByteArrayInputStream
import java.io.File
import java.io.FileInputStream

private const val VIRTUAL_HOST = "htmltomp4.appassets.local"

@SuppressLint("SetJavaScriptEnabled")
@Composable
fun StudioWebViewHost(
    modifier: Modifier = Modifier,
    viewModel: StudioViewModel,
    onWebViewReady: (WebView) -> Unit,
    onFileChooserRequested: (ValueCallback<Array<Uri>>?) -> Unit
) {
    AndroidView(
        modifier = modifier,
        factory = { context ->
            WebView(context).apply {
                layoutParams = ViewGroup.LayoutParams(
                    ViewGroup.LayoutParams.MATCH_PARENT,
                    ViewGroup.LayoutParams.MATCH_PARENT
                )
                setBackgroundColor(android.graphics.Color.parseColor("#090D16"))

                settings.apply {
                    javaScriptEnabled = true
                    domStorageEnabled = true
                    mediaPlaybackRequiresUserGesture = false
                    allowFileAccess = false
                    allowContentAccess = false
                    mixedContentMode = WebSettings.MIXED_CONTENT_NEVER_ALLOW
                    useWideViewPort = true
                    loadWithOverviewMode = true
                }

                addJavascriptInterface(viewModel.nativeEncoder, "AndroidNativeEncoder")

                addJavascriptInterface(object {
                    @JavascriptInterface
                    fun openHtmlPicker() {
                        post { viewModel.requestFilePicker() }
                    }

                    @JavascriptInterface
                    fun onExportReady(fileName: String, sizeMb: String, engine: String) {
                        post { viewModel.onWebExportReady(fileName, sizeMb, engine) }
                    }

                    @JavascriptInterface
                    fun setKeepAwake(active: Boolean) {
                        post { viewModel.setKeepAwake(active) }
                    }

                    @JavascriptInterface
                    fun updateRenderProgress(percent: Int, title: String, detail: String) {
                        post { viewModel.updateRenderProgress(percent, title, detail) }
                    }

                    @JavascriptInterface
                    fun finishRenderNotification(title: String, detail: String) {
                        post { viewModel.finishRenderNotification(title, detail) }
                    }

                    @JavascriptInterface
                    fun clearRenderNotification() {
                        post { viewModel.clearRenderNotification() }
                    }
                }, "AndroidHost")

                addJavascriptInterface(object {
                    @JavascriptInterface
                    fun saveBlobBase64(fileName: String, mimeType: String, base64: String) {
                        viewModel.saveBase64ToDownloads(fileName, mimeType, base64, notifyUser = true)
                    }

                    @JavascriptInterface
                    fun autoSaveBlobBase64(fileName: String, mimeType: String, base64: String) {
                        viewModel.saveBase64ToDownloads(fileName, mimeType, base64, notifyUser = false)
                    }

                    @JavascriptInterface
                    fun shareBlobBase64(fileName: String, mimeType: String, base64: String) {
                        viewModel.shareBase64Video(fileName, mimeType, base64)
                    }

                    @JavascriptInterface
                    fun saveExistingExport(internalFileName: String, displayName: String) {
                        viewModel.saveExistingExportToDownloads(internalFileName, displayName, notifyUser = true)
                    }

                    @JavascriptInterface
                    fun autoSaveExistingExport(internalFileName: String, displayName: String) {
                        viewModel.saveExistingExportToDownloads(internalFileName, displayName, notifyUser = false)
                    }

                    @JavascriptInterface
                    fun shareExistingExport(internalFileName: String, displayName: String) {
                        viewModel.shareExistingExport(internalFileName, displayName)
                    }
                }, "AndroidFileBridge")

                webViewClient = object : WebViewClient() {
                    override fun shouldInterceptRequest(
                        view: WebView?,
                        request: WebResourceRequest?
                    ): WebResourceResponse? {
                        val url = request?.url ?: return null
                        if (url.host == VIRTUAL_HOST) {
                            return serveLocalAsset(context, viewModel.exportManager, url.path ?: "/index.html")
                        }
                        return super.shouldInterceptRequest(view, request)
                    }
                }

                webChromeClient = object : WebChromeClient() {
                    override fun onShowFileChooser(
                        webView: WebView?,
                        filePathCallback: ValueCallback<Array<Uri>>?,
                        fileChooserParams: FileChooserParams?
                    ): Boolean {
                        onFileChooserRequested(filePathCallback)
                        return true
                    }
                }

                onWebViewReady(this)
                loadUrl("https://$VIRTUAL_HOST/index.html")
            }
        }
    )
}

private fun serveLocalAsset(
    context: Context,
    exportManager: ExportFileManager,
    rawPath: String
): WebResourceResponse {
    val cleanPath = rawPath.trimStart('/').ifEmpty { "index.html" }

    if (cleanPath.startsWith("__exports/")) {
        val fileName = Uri.decode(cleanPath.removePrefix("__exports/"))
        val file = File(exportManager.exportsDir, File(fileName).name)
        if (file.exists()) {
            val headers = mapOf(
                "Access-Control-Allow-Origin" to "*",
                "Cache-Control" to "no-store"
            )
            return WebResourceResponse("video/mp4", null, 200, "OK", headers, FileInputStream(file))
        }
        return WebResourceResponse("text/plain", "UTF-8", 404, "Not Found", emptyMap(), ByteArrayInputStream(ByteArray(0)))
    }

    val assetPath = "web/$cleanPath"
    return try {
        val stream = context.assets.open(assetPath)
        val mime = when {
            cleanPath.endsWith(".html") -> "text/html"
            cleanPath.endsWith(".js") || cleanPath.endsWith(".mjs") -> "application/javascript"
            cleanPath.endsWith(".css") -> "text/css"
            cleanPath.endsWith(".svg") -> "image/svg+xml"
            cleanPath.endsWith(".png") -> "image/png"
            cleanPath.endsWith(".json") -> "application/json"
            else -> "application/octet-stream"
        }
        val headers = mapOf(
            "Access-Control-Allow-Origin" to "*",
            "Cache-Control" to "no-cache"
        )
        WebResourceResponse(mime, "UTF-8", 200, "OK", headers, stream)
    } catch (_: Exception) {
        WebResourceResponse("text/plain", "UTF-8", 404, "Not Found", emptyMap(), ByteArrayInputStream(ByteArray(0)))
    }
}
