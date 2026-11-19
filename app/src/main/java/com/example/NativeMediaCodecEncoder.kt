package com.example

import android.graphics.BitmapFactory
import android.graphics.Rect
import android.media.MediaCodec
import android.media.MediaCodecInfo
import android.media.MediaExtractor
import android.media.MediaFormat
import android.media.MediaMuxer
import android.util.Base64
import android.util.Log
import android.view.Surface
import android.webkit.JavascriptInterface
import java.io.File
import java.nio.ByteBuffer
import java.util.UUID
import java.util.concurrent.ConcurrentHashMap

/**
 * Fallback H.264 + AAC MediaCodec/MediaMuxer bridge invoked from JS when a device's
 * WebView lacks WebCodecs VideoEncoder H.264 support, keeping the Virtual Clock
 * faster-than-real-time pipeline fully functional.
 */
class NativeMediaCodecEncoder(private val exportManager: ExportFileManager) {

    private data class Session(
        val id: String,
        val width: Int,
        val height: Int,
        val fps: Int,
        val codec: MediaCodec,
        val inputSurface: Surface,
        val muxer: MediaMuxer,
        val tempVideoFile: File,
        var trackIndex: Int = -1,
        var muxerStarted: Boolean = false,
        var emittedFrames: Long = 0L
    )

    private val sessions = ConcurrentHashMap<String, Session>()

    @JavascriptInterface
    fun startSession(width: Int, height: Int, fps: Int, bitrate: Int): String {
        return try {
            val safeW = (width / 2) * 2
            val safeH = (height / 2) * 2
            val id = UUID.randomUUID().toString().take(8)
            val tempFile = File(exportManager.exportsDir, "tmp_$id.mp4")

            val format = MediaFormat.createVideoFormat(MediaFormat.MIMETYPE_VIDEO_AVC, safeW, safeH).apply {
                setInteger(MediaFormat.KEY_COLOR_FORMAT, MediaCodecInfo.CodecCapabilities.COLOR_FormatSurface)
                setInteger(MediaFormat.KEY_BIT_RATE, bitrate.coerceAtLeast(1_500_000))
                setInteger(MediaFormat.KEY_FRAME_RATE, fps.coerceIn(15, 60))
                setInteger(MediaFormat.KEY_I_FRAME_INTERVAL, 2)
            }

            val codec = MediaCodec.createEncoderByType(MediaFormat.MIMETYPE_VIDEO_AVC)
            codec.configure(format, null, null, MediaCodec.CONFIGURE_FLAG_ENCODE)
            val surface = codec.createInputSurface()
            codec.start()

            val muxer = MediaMuxer(tempFile.absolutePath, MediaMuxer.OutputFormat.MUXER_OUTPUT_MPEG_4)
            sessions[id] = Session(
                id = id,
                width = safeW,
                height = safeH,
                fps = fps,
                codec = codec,
                inputSurface = surface,
                muxer = muxer,
                tempVideoFile = tempFile
            )
            id
        } catch (e: Exception) {
            Log.e("NativeEncoder", "startSession failed", e)
            ""
        }
    }

    @JavascriptInterface
    fun pushFrame(sessionId: String, frameIndex: Int, jpegBase64: String) {
        val s = sessions[sessionId] ?: return
        try {
            val bytes = Base64.decode(jpegBase64, Base64.DEFAULT)
            val bmp = BitmapFactory.decodeByteArray(bytes, 0, bytes.size) ?: return
            val canvas = s.inputSurface.lockCanvas(null)
            try {
                canvas.drawBitmap(bmp, null, Rect(0, 0, s.width, s.height), null)
            } finally {
                s.inputSurface.unlockCanvasAndPost(canvas)
                bmp.recycle()
            }
            drainVideoEncoder(s, endOfStream = false)
        } catch (e: Exception) {
            Log.e("NativeEncoder", "pushFrame error", e)
        }
    }

    @JavascriptInterface
    fun finishSession(sessionId: String, wavBase64: String): String {
        val s = sessions.remove(sessionId) ?: return ""
        return try {
            s.codec.signalEndOfInputStream()
            drainVideoEncoder(s, endOfStream = true)
            s.codec.stop()
            s.codec.release()
            s.inputSurface.release()
            if (s.muxerStarted) {
                s.muxer.stop()
            }
            s.muxer.release()

            val finalName = "render_${System.currentTimeMillis()}.mp4"
            val finalFile = File(exportManager.exportsDir, finalName)

            if (wavBase64.isBlank()) {
                s.tempVideoFile.renameTo(finalFile)
            } else {
                val wavBytes = Base64.decode(wavBase64, Base64.DEFAULT)
                val aacTemp = File(exportManager.exportsDir, "tmp_aud_${s.id}.mp4")
                val encodedAudioOk = encodeWavToAacMp4(wavBytes, aacTemp)
                if (encodedAudioOk) {
                    muxVideoAndAudio(s.tempVideoFile, aacTemp, finalFile)
                    s.tempVideoFile.delete()
                    aacTemp.delete()
                } else {
                    aacTemp.delete()
                    s.tempVideoFile.renameTo(finalFile)
                }
            }
            finalFile.name
        } catch (e: Exception) {
            Log.e("NativeEncoder", "finishSession failed", e)
            s.tempVideoFile.delete()
            ""
        }
    }

    @JavascriptInterface
    fun cancelSession(sessionId: String) {
        val s = sessions.remove(sessionId) ?: return
        try {
            s.codec.stop()
            s.codec.release()
            s.inputSurface.release()
            if (s.muxerStarted) s.muxer.stop()
            s.muxer.release()
        } catch (_: Exception) {
        } finally {
            s.tempVideoFile.delete()
        }
    }

    private fun drainVideoEncoder(s: Session, endOfStream: Boolean) {
        val bufferInfo = MediaCodec.BufferInfo()
        val timeoutUs = if (endOfStream) 10_000L else 0L
        while (true) {
            val outIndex = s.codec.dequeueOutputBuffer(bufferInfo, timeoutUs)
            when {
                outIndex == MediaCodec.INFO_TRY_AGAIN_LATER -> {
                    if (!endOfStream) break
                }
                outIndex == MediaCodec.INFO_OUTPUT_FORMAT_CHANGED -> {
                    if (!s.muxerStarted) {
                        s.trackIndex = s.muxer.addTrack(s.codec.outputFormat)
                        s.muxer.start()
                        s.muxerStarted = true
                    }
                }
                outIndex >= 0 -> {
                    val encodedData = s.codec.getOutputBuffer(outIndex)
                    if (encodedData != null && (bufferInfo.flags and MediaCodec.BUFFER_FLAG_CODEC_CONFIG) == 0 && bufferInfo.size > 0 && s.muxerStarted) {
                        encodedData.position(bufferInfo.offset)
                        encodedData.limit(bufferInfo.offset + bufferInfo.size)
                        bufferInfo.presentationTimeUs = (s.emittedFrames++) * (1_000_000L / s.fps.coerceAtLeast(1))
                        s.muxer.writeSampleData(s.trackIndex, encodedData, bufferInfo)
                    }
                    s.codec.releaseOutputBuffer(outIndex, false)
                    if ((bufferInfo.flags and MediaCodec.BUFFER_FLAG_END_OF_STREAM) != 0) break
                }
            }
        }
    }

    private fun encodeWavToAacMp4(wavBytes: ByteArray, outFile: File): Boolean {
        if (wavBytes.size <= 44) return false
        return try {
            val sampleRate = readIntLE(wavBytes, 24).coerceIn(8000, 48000)
            val channels = readShortLE(wavBytes, 22).coerceIn(1, 2)
            val pcmData = wavBytes.copyOfRange(44, wavBytes.size)

            val format = MediaFormat.createAudioFormat(MediaFormat.MIMETYPE_AUDIO_AAC, sampleRate, channels).apply {
                setInteger(MediaFormat.KEY_AAC_PROFILE, MediaCodecInfo.CodecProfileLevel.AACObjectLC)
                setInteger(MediaFormat.KEY_BIT_RATE, 128_000)
                setInteger(MediaFormat.KEY_MAX_INPUT_SIZE, 16384)
            }
            val codec = MediaCodec.createEncoderByType(MediaFormat.MIMETYPE_AUDIO_AAC)
            codec.configure(format, null, null, MediaCodec.CONFIGURE_FLAG_ENCODE)
            codec.start()

            val muxer = MediaMuxer(outFile.absolutePath, MediaMuxer.OutputFormat.MUXER_OUTPUT_MPEG_4)
            var trackIdx = -1
            var muxStarted = false

            val bytesPerSample = channels * 2
            var offset = 0
            var totalSamplesWritten = 0L
            var inputDone = false
            var outputDone = false
            val info = MediaCodec.BufferInfo()

            while (!outputDone) {
                if (!inputDone) {
                    val inIdx = codec.dequeueInputBuffer(5000)
                    if (inIdx >= 0) {
                        val inBuf = codec.getInputBuffer(inIdx)!!
                        inBuf.clear()
                        if (offset >= pcmData.size) {
                            val pts = (totalSamplesWritten * 1_000_000L) / sampleRate
                            codec.queueInputBuffer(inIdx, 0, 0, pts, MediaCodec.BUFFER_FLAG_END_OF_STREAM)
                            inputDone = true
                        } else {
                            val chunk = minOf(inBuf.capacity(), pcmData.size - offset)
                            inBuf.put(pcmData, offset, chunk)
                            val pts = (totalSamplesWritten * 1_000_000L) / sampleRate
                            totalSamplesWritten += chunk / bytesPerSample
                            offset += chunk
                            codec.queueInputBuffer(inIdx, 0, chunk, pts, 0)
                        }
                    }
                }

                val outIdx = codec.dequeueOutputBuffer(info, 5000)
                when {
                    outIdx == MediaCodec.INFO_OUTPUT_FORMAT_CHANGED -> {
                        if (!muxStarted) {
                            trackIdx = muxer.addTrack(codec.outputFormat)
                            muxer.start()
                            muxStarted = true
                        }
                    }
                    outIdx >= 0 -> {
                        val outBuf = codec.getOutputBuffer(outIdx)
                        if (outBuf != null && (info.flags and MediaCodec.BUFFER_FLAG_CODEC_CONFIG) == 0 && info.size > 0 && muxStarted) {
                            outBuf.position(info.offset)
                            outBuf.limit(info.offset + info.size)
                            muxer.writeSampleData(trackIdx, outBuf, info)
                        }
                        codec.releaseOutputBuffer(outIdx, false)
                        if ((info.flags and MediaCodec.BUFFER_FLAG_END_OF_STREAM) != 0) {
                            outputDone = true
                        }
                    }
                }
            }

            codec.stop()
            codec.release()
            if (muxStarted) muxer.stop()
            muxer.release()
            muxStarted
        } catch (e: Exception) {
            Log.e("NativeEncoder", "encodeWavToAacMp4 failed", e)
            false
        }
    }

    private fun muxVideoAndAudio(videoFile: File, audioFile: File, outFile: File) {
        val muxer = MediaMuxer(outFile.absolutePath, MediaMuxer.OutputFormat.MUXER_OUTPUT_MPEG_4)
        val vExt = MediaExtractor().apply { setDataSource(videoFile.absolutePath) }
        val aExt = MediaExtractor().apply { setDataSource(audioFile.absolutePath) }

        vExt.selectTrack(0)
        aExt.selectTrack(0)
        val vTrack = muxer.addTrack(vExt.getTrackFormat(0))
        val aTrack = muxer.addTrack(aExt.getTrackFormat(0))
        muxer.start()

        val buf = ByteBuffer.allocate(1024 * 512)
        val info = MediaCodec.BufferInfo()

        fun copyTrack(ext: MediaExtractor, targetTrack: Int) {
            while (true) {
                val size = ext.readSampleData(buf, 0)
                if (size < 0) break
                info.offset = 0
                info.size = size
                info.presentationTimeUs = ext.sampleTime
                info.flags = ext.sampleFlags
                muxer.writeSampleData(targetTrack, buf, info)
                ext.advance()
            }
        }

        copyTrack(vExt, vTrack)
        copyTrack(aExt, aTrack)

        vExt.release()
        aExt.release()
        muxer.stop()
        muxer.release()
    }

    private fun readIntLE(b: ByteArray, off: Int): Int =
        (b[off].toInt() and 0xff) or
            ((b[off + 1].toInt() and 0xff) shl 8) or
            ((b[off + 2].toInt() and 0xff) shl 16) or
            ((b[off + 3].toInt() and 0xff) shl 24)

    private fun readShortLE(b: ByteArray, off: Int): Int =
        (b[off].toInt() and 0xff) or ((b[off + 1].toInt() and 0xff) shl 8)
}
