package com.example

import android.Manifest
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.view.WindowManager
import android.webkit.ValueCallback
import android.webkit.WebView
import androidx.activity.ComponentActivity
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.activity.result.contract.ActivityResultContracts
import androidx.activity.viewModels
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.safeDrawing
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Bolt
import androidx.compose.material.icons.filled.DeleteOutline
import androidx.compose.material.icons.filled.Download
import androidx.compose.material.icons.filled.FolderOpen
import androidx.compose.material.icons.filled.MovieCreation
import androidx.compose.material.icons.filled.Share
import androidx.compose.material.icons.filled.Translate
import androidx.compose.material.icons.filled.VideoLibrary
import androidx.compose.material3.Badge
import androidx.compose.material3.BadgedBox
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.FilledTonalButton
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.Scaffold
import androidx.compose.material3.SnackbarHost
import androidx.compose.material3.SnackbarHostState
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TopAppBar
import androidx.compose.material3.TopAppBarDefaults
import androidx.compose.material3.minimumInteractiveComponentSize
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.core.content.ContextCompat
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.example.ui.theme.HtmlToMp4Theme
import org.json.JSONObject

class MainActivity : ComponentActivity() {

    private val viewModel: StudioViewModel by viewModels()
    private var webViewRef: WebView? = null
    private var pendingWebFileCallback: ValueCallback<Array<Uri>>? = null

    private val htmlPickerLauncher = registerForActivityResult(
        ActivityResultContracts.OpenDocument()
    ) { uri ->
        if (uri != null) {
            viewModel.handlePickedUri(uri)
        }
    }

    private val webViewFileChooserLauncher = registerForActivityResult(
        ActivityResultContracts.OpenDocument()
    ) { uri ->
        val cb = pendingWebFileCallback
        pendingWebFileCallback = null
        if (cb != null) {
            cb.onReceiveValue(if (uri != null) arrayOf(uri) else null)
        }
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        enableEdgeToEdge()

        setContent {
            HtmlToMp4Theme {
                val context = LocalContext.current
                val uiState by viewModel.uiState.collectAsStateWithLifecycle()
                val snackbarHostState = remember { SnackbarHostState() }
                var webViewInstance by remember { mutableStateOf<WebView?>(null) }

                val notifPermissionLauncher = rememberLauncherForActivityResult(
                    ActivityResultContracts.RequestPermission()
                ) { _ -> /* Graceful: progress UI remains visible inside app even if denied */ }

                LaunchedEffect(Unit) {
                    viewModel.events.collect { event ->
                        when (event) {
                            is StudioEvent.OpenDocumentPicker -> {
                                htmlPickerLauncher.launch(arrayOf("text/html", "application/xhtml+xml", "*/*"))
                            }
                            is StudioEvent.InjectHtml -> {
                                val quotedName = JSONObject.quote(event.filename)
                                val quotedHtml = JSONObject.quote(event.htmlContent)
                                webViewInstance?.evaluateJavascript(
                                    "window.loadHtmlFromHost && window.loadHtmlFromHost($quotedName, $quotedHtml);",
                                    null
                                )
                            }
                            is StudioEvent.InjectLanguage -> {
                                val qLang = JSONObject.quote(event.language)
                                webViewInstance?.evaluateJavascript(
                                    "window.setAppLanguage && window.setAppLanguage($qLang);",
                                    null
                                )
                            }
                            is StudioEvent.InjectHostError -> {
                                val qEn = JSONObject.quote(event.enMessage)
                                val qBn = JSONObject.quote(event.bnMessage)
                                webViewInstance?.evaluateJavascript(
                                    "window.showHostError && window.showHostError($qEn, $qBn);",
                                    null
                                )
                            }
                            is StudioEvent.SetKeepAwake -> {
                                if (event.active) {
                                    window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
                                } else {
                                    window.clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
                                }
                            }
                            is StudioEvent.RequestNotificationPermissionIfNeeded -> {
                                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
                                    val granted = ContextCompat.checkSelfPermission(
                                        context,
                                        Manifest.permission.POST_NOTIFICATIONS
                                    ) == PackageManager.PERMISSION_GRANTED
                                    if (!granted) {
                                        notifPermissionLauncher.launch(Manifest.permission.POST_NOTIFICATIONS)
                                    }
                                }
                            }
                            is StudioEvent.ShowSnackbar -> {
                                snackbarHostState.showSnackbar(event.message)
                            }
                            is StudioEvent.LaunchShare -> {
                                startActivity(event.intent)
                            }
                        }
                    }
                }

                StudioMainScreen(
                    uiState = uiState,
                    snackbarHostState = snackbarHostState,
                    viewModel = viewModel,
                    onWebViewReady = { wv ->
                        webViewRef = wv
                        webViewInstance = wv
                    },
                    onFileChooserRequested = { cb ->
                        pendingWebFileCallback?.onReceiveValue(null)
                        pendingWebFileCallback = cb
                        webViewFileChooserLauncher.launch(arrayOf("text/html", "application/xhtml+xml", "*/*"))
                    }
                )
            }
        }
    }

    override fun onDestroy() {
        window.clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
        webViewRef?.destroy()
        webViewRef = null
        super.onDestroy()
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun StudioMainScreen(
    uiState: StudioUiState,
    snackbarHostState: SnackbarHostState,
    viewModel: StudioViewModel,
    onWebViewReady: (WebView) -> Unit,
    onFileChooserRequested: (ValueCallback<Array<Uri>>?) -> Unit
) {
    val isBn = uiState.language == "bn"

    Scaffold(
        modifier = Modifier.fillMaxSize(),
        containerColor = MaterialTheme.colorScheme.background,
        contentWindowInsets = WindowInsets.safeDrawing,
        snackbarHost = { SnackbarHost(hostState = snackbarHostState) },
        topBar = {
            TopAppBar(
                colors = TopAppBarDefaults.topAppBarColors(
                    containerColor = MaterialTheme.colorScheme.surface,
                    titleContentColor = MaterialTheme.colorScheme.onSurface
                ),
                title = {
                    Row(
                        verticalAlignment = Alignment.CenterVertically,
                        horizontalArrangement = Arrangement.spacedBy(10.dp)
                    ) {
                        Box(
                            modifier = Modifier
                                .size(34.dp)
                                .clip(RoundedCornerShape(10.dp))
                                .background(MaterialTheme.colorScheme.primaryContainer)
                                .border(1.dp, MaterialTheme.colorScheme.primary.copy(alpha = 0.5f), RoundedCornerShape(10.dp)),
                            contentAlignment = Alignment.Center
                        ) {
                            Icon(
                                imageVector = Icons.Filled.MovieCreation,
                                contentDescription = null,
                                tint = MaterialTheme.colorScheme.primary,
                                modifier = Modifier.size(20.dp)
                            )
                        }
                        Column {
                            Text(
                                text = if (isBn) "HTML থেকে MP4" else stringResource(R.string.app_name),
                                style = MaterialTheme.typography.titleLarge,
                                maxLines = 1,
                                overflow = TextOverflow.Ellipsis
                            )
                            Row(
                                verticalAlignment = Alignment.CenterVertically,
                                horizontalArrangement = Arrangement.spacedBy(4.dp)
                            ) {
                                if (uiState.isKeepAwakeActive) {
                                    Icon(
                                        imageVector = Icons.Filled.Bolt,
                                        contentDescription = "Screen kept awake",
                                        tint = MaterialTheme.colorScheme.tertiary,
                                        modifier = Modifier.size(12.dp)
                                    )
                                }
                                Text(
                                    text = if (uiState.isKeepAwakeActive) {
                                        if (isBn) "রেন্ডারিং চলছে • স্ক্রিন চালু রাখা হয়েছে" else "Rendering • Screen Awake"
                                    } else {
                                        uiState.lastLoadedFileName
                                            ?: if (isBn) "অফলাইন স্টুডিও • WebCodecs" else "Offline Studio • WebCodecs"
                                    },
                                    style = MaterialTheme.typography.labelSmall,
                                    color = if (uiState.isKeepAwakeActive) MaterialTheme.colorScheme.tertiary else MaterialTheme.colorScheme.primary,
                                    maxLines = 1,
                                    overflow = TextOverflow.Ellipsis
                                )
                            }
                        }
                    }
                },
                actions = {
                    FilledTonalButton(
                        onClick = { viewModel.requestFilePicker() },
                        modifier = Modifier
                            .minimumInteractiveComponentSize()
                            .testTag("open_html_button"),
                        contentPadding = PaddingValues(horizontal = 12.dp, vertical = 6.dp)
                    ) {
                        Icon(
                            imageVector = Icons.Filled.FolderOpen,
                            contentDescription = stringResource(R.string.action_open_html),
                            modifier = Modifier.size(18.dp)
                        )
                        Spacer(modifier = Modifier.width(6.dp))
                        Text(
                            text = if (isBn) "ফাইল" else "HTML",
                            style = MaterialTheme.typography.labelLarge
                        )
                    }

                    IconButton(
                        onClick = { viewModel.toggleLanguage() },
                        modifier = Modifier
                            .minimumInteractiveComponentSize()
                            .testTag("language_toggle_button")
                    ) {
                        Icon(
                            imageVector = Icons.Filled.Translate,
                            contentDescription = stringResource(R.string.language_toggle_desc),
                            tint = MaterialTheme.colorScheme.primary
                        )
                    }

                    IconButton(
                        onClick = { viewModel.setExportsSheetVisible(true) },
                        modifier = Modifier
                            .minimumInteractiveComponentSize()
                            .testTag("exports_sheet_button")
                    ) {
                        BadgedBox(
                            badge = {
                                if (uiState.exports.isNotEmpty()) {
                                    Badge { Text(text = uiState.exports.size.toString()) }
                                }
                            }
                        ) {
                            Icon(
                                imageVector = Icons.Filled.VideoLibrary,
                                contentDescription = stringResource(R.string.action_exports)
                            )
                        }
                    }
                }
            )
        }
    ) { innerPadding ->
        StudioWebViewHost(
            modifier = Modifier
                .fillMaxSize()
                .padding(innerPadding),
            viewModel = viewModel,
            onWebViewReady = onWebViewReady,
            onFileChooserRequested = onFileChooserRequested
        )
    }

    if (uiState.showExportsSheet) {
        ModalBottomSheet(
            onDismissRequest = { viewModel.setExportsSheetVisible(false) },
            containerColor = MaterialTheme.colorScheme.surface
        ) {
            ExportsSheetContent(
                isBn = isBn,
                exports = uiState.exports,
                onSaveToDownloads = { item ->
                    viewModel.saveExistingExportToDownloads(item.fileName, item.fileName)
                },
                onShare = { item ->
                    viewModel.shareExistingExport(item.fileName, item.fileName)
                },
                onDelete = { item ->
                    viewModel.deleteExport(item.fileName)
                }
            )
        }
    }
}

@Composable
private fun ExportsSheetContent(
    isBn: Boolean,
    exports: List<ExportedVideoItem>,
    onSaveToDownloads: (ExportedVideoItem) -> Unit,
    onShare: (ExportedVideoItem) -> Unit,
    onDelete: (ExportedVideoItem) -> Unit
) {
    Column(
        modifier = Modifier
            .fillMaxWidth()
            .navigationBarsPadding()
            .padding(horizontal = 16.dp, vertical = 8.dp)
    ) {
        Text(
            text = if (isBn) "সংরক্ষিত MP4 এক্সপোর্ট" else "Saved Video Exports",
            style = MaterialTheme.typography.headlineSmall,
            fontWeight = FontWeight.Bold
        )
        Spacer(modifier = Modifier.height(4.dp))
        Text(
            text = if (isBn) "আপনার রূপান্তরিত ভিডিও ডাউনলোডসে সেভ বা শেয়ার করুন" else "Save converted videos to Downloads or share them",
            style = MaterialTheme.typography.bodyMedium,
            color = MaterialTheme.colorScheme.onSurfaceVariant
        )
        Spacer(modifier = Modifier.height(14.dp))

        if (exports.isEmpty()) {
            Surface(
                modifier = Modifier.fillMaxWidth(),
                shape = MaterialTheme.shapes.medium,
                color = MaterialTheme.colorScheme.surfaceVariant
            ) {
                Column(
                    modifier = Modifier.padding(24.dp),
                    horizontalAlignment = Alignment.CenterHorizontally
                ) {
                    Icon(
                        imageVector = Icons.Filled.VideoLibrary,
                        contentDescription = null,
                        tint = MaterialTheme.colorScheme.primary,
                        modifier = Modifier.size(36.dp)
                    )
                    Spacer(modifier = Modifier.height(8.dp))
                    Text(
                        text = if (isBn) "এখনও কোনো ভিডিও এক্সপোর্ট করা হয়নি" else "No exported videos yet",
                        style = MaterialTheme.typography.titleMedium
                    )
                }
            }
            Spacer(modifier = Modifier.height(24.dp))
        } else {
            LazyColumn(
                verticalArrangement = Arrangement.spacedBy(10.dp),
                contentPadding = PaddingValues(bottom = 24.dp)
            ) {
                items(exports, key = { it.fileName }) { item ->
                    val sizeMb = String.format("%.2f MB", item.sizeBytes / (1024.0 * 1024.0))
                    Card(
                        colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surfaceVariant),
                        shape = MaterialTheme.shapes.medium
                    ) {
                        Row(
                            modifier = Modifier
                                .fillMaxWidth()
                                .padding(horizontal = 14.dp, vertical = 12.dp),
                            verticalAlignment = Alignment.CenterVertically
                        ) {
                            Column(modifier = Modifier.weight(1f)) {
                                Text(
                                    text = item.fileName,
                                    style = MaterialTheme.typography.titleMedium,
                                    maxLines = 1,
                                    overflow = TextOverflow.Ellipsis
                                )
                                Text(
                                    text = "$sizeMb • ${item.createdAtLabel}",
                                    style = MaterialTheme.typography.labelMedium,
                                    color = MaterialTheme.colorScheme.onSurfaceVariant
                                )
                            }
                            IconButton(
                                onClick = { onSaveToDownloads(item) },
                                modifier = Modifier
                                    .minimumInteractiveComponentSize()
                                    .testTag("save_export_${item.fileName}")
                            ) {
                                Icon(
                                    imageVector = Icons.Filled.Download,
                                    contentDescription = stringResource(R.string.action_save_downloads),
                                    tint = MaterialTheme.colorScheme.primary
                                )
                            }
                            IconButton(
                                onClick = { onShare(item) },
                                modifier = Modifier
                                    .minimumInteractiveComponentSize()
                                    .testTag("share_export_${item.fileName}")
                            ) {
                                Icon(
                                    imageVector = Icons.Filled.Share,
                                    contentDescription = stringResource(R.string.action_share)
                                )
                            }
                            IconButton(
                                onClick = { onDelete(item) },
                                modifier = Modifier
                                    .minimumInteractiveComponentSize()
                                    .testTag("delete_export_${item.fileName}")
                            ) {
                                Icon(
                                    imageVector = Icons.Filled.DeleteOutline,
                                    contentDescription = "Delete",
                                    tint = MaterialTheme.colorScheme.error
                                )
                            }
                        }
                    }
                }
            }
        }
    }
}
