package com.example

import android.content.ContentValues
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.os.Environment
import android.provider.MediaStore
import android.util.Base64
import androidx.core.content.FileProvider
import java.io.File
import java.io.FileOutputStream
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale

data class ExportedVideoItem(
    val fileName: String,
    val filePath: String,
    val sizeBytes: Long,
    val createdAtLabel: String
)

class ExportFileManager(private val context: Context) {

    val exportsDir: File
        get() = File(context.filesDir, "exports").apply { mkdirs() }

    fun getExportFile(fileName: String): File {
        val safeName = File(fileName).name
        return File(exportsDir, safeName)
    }

    fun writeBase64Export(fileName: String, base64Payload: String): File {
        val safeName = sanitizeFileName(fileName)
        val outFile = File(exportsDir, safeName)
        val bytes = Base64.decode(base64Payload, Base64.DEFAULT)
        FileOutputStream(outFile).use { it.write(bytes) }
        return outFile
    }

    fun copyToPublicDownloads(sourceFile: File, displayName: String, mimeType: String = "video/mp4"): Uri? {
        val cleanName = sanitizeFileName(displayName)
        return if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            val values = ContentValues().apply {
                put(MediaStore.Downloads.DISPLAY_NAME, cleanName)
                put(MediaStore.Downloads.MIME_TYPE, mimeType)
                put(MediaStore.Downloads.RELATIVE_PATH, Environment.DIRECTORY_DOWNLOADS + "/HTMLtoMP4")
                put(MediaStore.Downloads.IS_PENDING, 1)
            }
            val resolver = context.contentResolver
            val uri = resolver.insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, values) ?: return null
            resolver.openOutputStream(uri)?.use { out ->
                sourceFile.inputStream().use { input -> input.copyTo(out) }
            }
            values.clear()
            values.put(MediaStore.Downloads.IS_PENDING, 0)
            resolver.update(uri, values, null, null)
            uri
        } else {
            val dir = context.getExternalFilesDir(Environment.DIRECTORY_MOVIES) ?: exportsDir
            dir.mkdirs()
            val dest = File(dir, cleanName)
            sourceFile.copyTo(dest, overwrite = true)
            FileProvider.getUriForFile(context, "${context.packageName}.fileprovider", dest)
        }
    }

    fun createShareIntent(file: File, mimeType: String = "video/mp4"): Intent {
        val uri = FileProvider.getUriForFile(context, "${context.packageName}.fileprovider", file)
        return Intent(Intent.ACTION_SEND).apply {
            type = mimeType
            putExtra(Intent.EXTRA_STREAM, uri)
            addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
        }
    }

    fun listExports(): List<ExportedVideoItem> {
        val formatter = SimpleDateFormat("MMM dd, HH:mm", Locale.getDefault())
        return exportsDir.listFiles()
            ?.filter { it.isFile && (it.name.endsWith(".mp4") || it.name.endsWith(".webm")) && !it.name.startsWith("tmp_") }
            ?.sortedByDescending { it.lastModified() }
            ?.map { f ->
                ExportedVideoItem(
                    fileName = f.name,
                    filePath = f.absolutePath,
                    sizeBytes = f.length(),
                    createdAtLabel = formatter.format(Date(f.lastModified()))
                )
            } ?: emptyList()
    }

    fun deleteExport(fileName: String) {
        val f = getExportFile(fileName)
        if (f.exists()) f.delete()
    }

    fun sanitizeFileName(raw: String): String {
        val base = raw.replace(Regex("[^a-zA-Z0-9._-]"), "_")
        return if (base.isBlank()) "animation_${System.currentTimeMillis()}.mp4" else base
    }
}
