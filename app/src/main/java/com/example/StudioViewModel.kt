package com.example

import android.app.Application
import android.content.Intent
import android.net.Uri
import android.provider.OpenableColumns
import androidx.lifecycle.AndroidViewModel
import androidx.lifecycle.viewModelScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asSharedFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import java.io.File

data class StudioUiState(
    val language: String = "en",
    val exports: List<ExportedVideoItem> = emptyList(),
    val showExportsSheet: Boolean = false,
    val lastLoadedFileName: String? = null,
    val isKeepAwakeActive: Boolean = false
)

sealed interface StudioEvent {
    data class InjectHtml(val filename: String, val htmlContent: String) : StudioEvent
    data class InjectLanguage(val language: String) : StudioEvent
    data class InjectHostError(val enMessage: String, val bnMessage: String) : StudioEvent
    data class ShowSnackbar(val message: String) : StudioEvent
    data class LaunchShare(val intent: Intent) : StudioEvent
    data class SetKeepAwake(val active: Boolean) : StudioEvent
    data object RequestNotificationPermissionIfNeeded : StudioEvent
    data object OpenDocumentPicker : StudioEvent
}

class StudioViewModel(application: Application) : AndroidViewModel(application) {

    val exportManager = ExportFileManager(application.applicationContext)
    val nativeEncoder = NativeMediaCodecEncoder(exportManager)
    val progressNotifier = RenderProgressNotifier(application.applicationContext)

    private val _uiState = MutableStateFlow(StudioUiState())
    val uiState: StateFlow<StudioUiState> = _uiState.asStateFlow()

    private val _events = MutableSharedFlow<StudioEvent>(extraBufferCapacity = 24)
    val events = _events.asSharedFlow()

    init {
        refreshExports()
    }

    fun toggleLanguage() {
        val next = if (_uiState.value.language == "en") "bn" else "en"
        _uiState.update { it.copy(language = next) }
        _events.tryEmit(StudioEvent.InjectLanguage(next))
    }

    fun setExportsSheetVisible(visible: Boolean) {
        if (visible) refreshExports()
        _uiState.update { it.copy(showExportsSheet = visible) }
    }

    fun refreshExports() {
        viewModelScope.launch(Dispatchers.IO) {
            val items = exportManager.listExports()
            _uiState.update { it.copy(exports = items) }
        }
    }

    fun requestFilePicker() {
        _events.tryEmit(StudioEvent.OpenDocumentPicker)
    }

    fun setKeepAwake(active: Boolean) {
        _uiState.update { it.copy(isKeepAwakeActive = active) }
        _events.tryEmit(StudioEvent.SetKeepAwake(active))
        if (active) {
            _events.tryEmit(StudioEvent.RequestNotificationPermissionIfNeeded)
        }
    }

    fun updateRenderProgress(percent: Int, title: String, detail: String) {
        progressNotifier.showProgress(percent, title, detail)
    }

    fun finishRenderNotification(title: String, detail: String) {
        progressNotifier.showComplete(title, detail)
    }

    fun clearRenderNotification() {
        progressNotifier.cancel()
    }

    fun handlePickedUri(uri: Uri) {
        viewModelScope.launch {
            val ctx = getApplication<Application>().applicationContext
            val result = withContext(Dispatchers.IO) {
                runCatching {
                    val fileName = resolveDisplayName(ctx, uri) ?: "upload.html"
                    val lower = fileName.lowercase()
                    if (!lower.endsWith(".html") && !lower.endsWith(".htm")) {
                        return@runCatching Result.failure<Pair<String, String>>(IllegalArgumentException("NOT_HTML"))
                    }
                    val bytes = ctx.contentResolver.openInputStream(uri)?.use { it.readBytes() }
                        ?: return@runCatching Result.failure(IllegalStateException("EMPTY"))
                    if (bytes.size > 15 * 1024 * 1024) {
                        return@runCatching Result.failure(IllegalArgumentException("TOO_LARGE"))
                    }
                    if (bytes.any { it == 0.toByte() }) {
                        return@runCatching Result.failure(IllegalArgumentException("BINARY"))
                    }
                    val text = bytes.toString(Charsets.UTF_8)
                    Result.success(fileName to text)
                }.getOrElse { Result.failure(it) }
            }

            result.onSuccess { (name, content) ->
                _uiState.update { it.copy(lastLoadedFileName = name) }
                _events.emit(StudioEvent.InjectHtml(name, content))
            }.onFailure {
                _events.emit(
                    StudioEvent.InjectHostError(
                        enMessage = "Unsupported or unreadable file. Please choose a valid .html animation file.",
                        bnMessage = "ফাইলটি পড়া যাচ্ছে না বা এটি বৈধ .html ফাইল নয়। অনুগ্রহ করে একটি সঠিক .html ফাইল নির্বাচন করুন।"
                    )
                )
            }
        }
    }

    fun saveBase64ToDownloads(fileName: String, mimeType: String, base64: String, notifyUser: Boolean = true) {
        viewModelScope.launch(Dispatchers.IO) {
            val saved = runCatching {
                val internalFile = exportManager.writeBase64Export(fileName, base64)
                exportManager.copyToPublicDownloads(internalFile, fileName, mimeType)
                internalFile
            }
            saved.onSuccess {
                refreshExports()
                val title = if (_uiState.value.language == "bn") "MP4 তৈরি সম্পন্ন" else "MP4 Saved to Downloads"
                val detail = "Downloads/HTMLtoMP4/$fileName"
                progressNotifier.showComplete(title, detail)
                if (notifyUser) {
                    val msg = if (_uiState.value.language == "bn") {
                        "Downloads/HTMLtoMP4-এ সংরক্ষিত হয়েছে: $fileName"
                    } else {
                        "Saved to Downloads/HTMLtoMP4: $fileName"
                    }
                    _events.emit(StudioEvent.ShowSnackbar(msg))
                }
            }.onFailure { err ->
                _events.emit(StudioEvent.ShowSnackbar("Save failed: ${err.message}"))
            }
        }
    }

    fun saveExistingExportToDownloads(internalFileName: String, displayName: String, notifyUser: Boolean = true) {
        viewModelScope.launch(Dispatchers.IO) {
            val file = exportManager.getExportFile(internalFileName)
            if (!file.exists()) return@launch
            val mime = if (displayName.endsWith(".webm")) "video/webm" else "video/mp4"
            exportManager.copyToPublicDownloads(file, displayName, mime)
            refreshExports()
            val title = if (_uiState.value.language == "bn") "MP4 তৈরি সম্পন্ন" else "MP4 Saved to Downloads"
            progressNotifier.showComplete(title, "Downloads/HTMLtoMP4/$displayName")
            if (notifyUser) {
                val msg = if (_uiState.value.language == "bn") {
                    "Downloads/HTMLtoMP4-এ সংরক্ষিত হয়েছে: $displayName"
                } else {
                    "Saved to Downloads/HTMLtoMP4: $displayName"
                }
                _events.emit(StudioEvent.ShowSnackbar(msg))
            }
        }
    }

    fun shareBase64Video(fileName: String, mimeType: String, base64: String) {
        viewModelScope.launch(Dispatchers.IO) {
            val file = exportManager.writeBase64Export(fileName, base64)
            refreshExports()
            val intent = exportManager.createShareIntent(file, mimeType)
            _events.emit(StudioEvent.LaunchShare(Intent.createChooser(intent, "Share Video")))
        }
    }

    fun shareExistingExport(internalFileName: String, displayName: String = internalFileName) {
        viewModelScope.launch(Dispatchers.IO) {
            val file = exportManager.getExportFile(internalFileName)
            if (!file.exists()) return@launch
            val mime = if (displayName.endsWith(".webm")) "video/webm" else "video/mp4"
            val intent = exportManager.createShareIntent(file, mime)
            _events.emit(StudioEvent.LaunchShare(Intent.createChooser(intent, "Share $displayName")))
        }
    }

    fun deleteExport(fileName: String) {
        viewModelScope.launch(Dispatchers.IO) {
            exportManager.deleteExport(fileName)
            refreshExports()
        }
    }

    fun onWebExportReady(fileName: String, sizeMb: String, engine: String) {
        refreshExports()
        val msg = if (_uiState.value.language == "bn") {
            "তৈরি সম্পন্ন: $fileName ($sizeMb MB)"
        } else {
            "Ready: $fileName ($sizeMb MB)"
        }
        _events.tryEmit(StudioEvent.ShowSnackbar(msg))
    }

    private fun resolveDisplayName(ctx: android.content.Context, uri: Uri): String? {
        if (uri.scheme == "file") return File(uri.path ?: "").name
        ctx.contentResolver.query(uri, arrayOf(OpenableColumns.DISPLAY_NAME), null, null, null)?.use { cursor ->
            if (cursor.moveToFirst()) {
                val idx = cursor.getColumnIndex(OpenableColumns.DISPLAY_NAME)
                if (idx >= 0) return cursor.getString(idx)
            }
        }
        return uri.lastPathSegment
    }
}
