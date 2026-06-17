package com.liteeditor.pult

import android.Manifest
import android.annotation.SuppressLint
import android.app.Activity
import android.content.ContentValues
import android.content.pm.PackageManager
import android.graphics.Rect
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.os.Environment
import android.provider.MediaStore
import android.provider.Settings
import android.util.Base64
import android.view.ViewGroup
import android.webkit.GeolocationPermissions
import android.webkit.JavascriptInterface
import android.webkit.WebChromeClient
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.Toast
import org.json.JSONObject
import java.io.File
import java.io.FileOutputStream
import java.io.OutputStream

/**
 * Тонкая WebView-обёртка. Весь UI пульта — в assets/index.html + app.js (бандл
 * с xterm). Нативного кода минимум: создать WebView, включить JS/DOM-storage,
 * прокинуть конфиг (адрес релея/комната/токен из BuildConfig) в страницу и
 * загрузить локальный ассет. Дальше JS сам открывает WebSocket к релею.
 *
 * Клавиатура (больная тема старых WebView, Chrome 79): ни windowSoftInputMode=adjustResize,
 * ни JS-приёмы (visualViewport) не держат UI на месте — движок прокручивает СВОЙ документ к
 * полю фокуса (скрытая textarea xterm внизу), и шапка с тулбаром уезжают вверх, а после
 * закрытия клавиатуры не доезжают обратно. Лечим нативно тремя приёмами:
 *   1) clamp прокрутки WebView в 0 (setOnScrollChangeListener) — документ физически не может
 *      проскроллиться вверх, шапка остаётся на месте (внутренний скрол терминала/списка не
 *      затрагивается — это скрол дочерних div, а не самого WebView);
 *   2) resize WebView до видимой высоты, когда клавиатура открыта (терминал ужимается, а не
 *      прячется под клавиатурой);
 *   3) на смену состояния клавиатуры — жёсткий сброс прокрутки + сигнал странице
 *      (window.__kbChanged), чтобы JS добил выравнивание после анимации закрытия.
 */
class MainActivity : Activity() {
    private lateinit var web: WebView
    private var usableHeightPrev = 0
    private var keyboardOpen = false
    // Отложенный grant геолокации WebView: ждём ответа на runtime-разрешение Android.
    private var geoOrigin: String? = null
    private var geoCallback: GeolocationPermissions.Callback? = null

    @SuppressLint("SetJavaScriptEnabled", "ClickableViewAccessibility")
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)

        web = WebView(this)
        web.layoutParams = ViewGroup.LayoutParams(
            ViewGroup.LayoutParams.MATCH_PARENT,
            ViewGroup.LayoutParams.MATCH_PARENT
        )
        setContentView(web)

        web.settings.javaScriptEnabled = true
        web.settings.domStorageEnabled = true
        @Suppress("DEPRECATION")
        web.settings.databaseEnabled = true   // localStorage на file:// надёжнее
        web.settings.allowFileAccess = true
        web.settings.setGeolocationEnabled(true)   // местоположение по запросу с ПК (модалка «Пульты»)
        web.isVerticalScrollBarEnabled = false
        web.overScrollMode = WebView.OVER_SCROLL_NEVER
        WebView.setWebContentsDebuggingEnabled(true)

        // Мост сохранения скачанных из стора файлов (стримом на диск, не через память JS).
        web.addJavascriptInterface(Downloader(), "LiteNative")
        // Read-only диагностика устройства/WebView для отладки терминала на конкретном планшете.
        web.addJavascriptInterface(DeviceInfo(), "LiteDevice")
        // На Android <10 запись в общую папку «Загрузки» требует разрешения.
        if (Build.VERSION.SDK_INT < 29 &&
            checkSelfPermission(Manifest.permission.WRITE_EXTERNAL_STORAGE) != PackageManager.PERMISSION_GRANTED) {
            try { requestPermissions(arrayOf(Manifest.permission.WRITE_EXTERNAL_STORAGE), 1) } catch (_: Exception) {}
        }

        // (1) Документ WebView НИКОГДА не должен прокручиваться сам — держим в 0,0.
        web.setOnScrollChangeListener { v, _, _, _, _ ->
            if (v.scrollY != 0 || v.scrollX != 0) v.scrollTo(0, 0)
        }
        // (2)+(3) Реакция на клавиатуру.
        web.viewTreeObserver.addOnGlobalLayoutListener { onLayoutChanged() }

        val cfg = JSONObject()
            .put("relayUrl", BuildConfig.RELAY_URL)
            .put("room", BuildConfig.ROOM)
            .put("token", BuildConfig.TOKEN)

        web.webViewClient = object : WebViewClient() {
            override fun onPageFinished(view: WebView?, url: String?) {
                // Передаём конфиг в страницу после загрузки.
                view?.evaluateJavascript("window.__bootLite(" + cfg.toString() + ")", null)
            }
        }

        // Геолокация из JS (navigator.geolocation): WebView спрашивает нас; если runtime-разрешения
        // ещё нет — запрашиваем у системы и отвечаем WebView после ответа пользователя.
        web.webChromeClient = object : WebChromeClient() {
            override fun onGeolocationPermissionsShowPrompt(origin: String?, callback: GeolocationPermissions.Callback?) {
                if (origin == null || callback == null) return
                val granted = checkSelfPermission(Manifest.permission.ACCESS_FINE_LOCATION) == PackageManager.PERMISSION_GRANTED ||
                    checkSelfPermission(Manifest.permission.ACCESS_COARSE_LOCATION) == PackageManager.PERMISSION_GRANTED
                if (granted) { callback.invoke(origin, true, false); return }
                geoOrigin = origin; geoCallback = callback
                try {
                    requestPermissions(arrayOf(Manifest.permission.ACCESS_FINE_LOCATION, Manifest.permission.ACCESS_COARSE_LOCATION), 2)
                } catch (_: Exception) { callback.invoke(origin, false, false); geoOrigin = null; geoCallback = null }
            }
        }

        web.loadUrl("file:///android_asset/index.html")
    }

    override fun onRequestPermissionsResult(requestCode: Int, permissions: Array<out String>, grantResults: IntArray) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults)
        if (requestCode == 2) {
            val ok = grantResults.any { it == PackageManager.PERMISSION_GRANTED }
            geoCallback?.invoke(geoOrigin, ok, false)
            geoOrigin = null; geoCallback = null
        }
    }

    private fun onLayoutChanged() {
        val r = Rect()
        web.getWindowVisibleDisplayFrame(r)
        val usableNow = r.bottom - r.top
        val rootHeight = web.rootView.height
        // Запас 150px: мелкие колебания (статус-бар) не считаем клавиатурой.
        val nowOpen = rootHeight - usableNow > 150

        // (2) Высота WebView = видимой части (клавиатура открыта) либо во весь экран.
        if (usableNow != usableHeightPrev) {
            usableHeightPrev = usableNow
            val lp = web.layoutParams
            lp.height = if (nowOpen) usableNow else ViewGroup.LayoutParams.MATCH_PARENT
            web.layoutParams = lp
            web.requestLayout()
        }

        // (3) Клавиатура показалась/скрылась → сброс прокрутки + сигнал странице.
        if (nowOpen != keyboardOpen) {
            keyboardOpen = nowOpen
            web.post {
                web.scrollTo(0, 0)
                web.evaluateJavascript(
                    "window.__kbChanged&&window.__kbChanged(" + (if (nowOpen) "true" else "false") + ")",
                    null
                )
            }
        }
    }

    /**
     * JS-мост сохранения файлов из стора. JS зовёт start() → серия chunk() → finish().
     * Пишем стримом на диск (в «Загрузки»), а не копим в памяти WebView — большой файл не
     * уронит вкладку. Android 10+ — через MediaStore (без разрешений); <10 — в общую папку
     * Downloads (нужно WRITE_EXTERNAL_STORAGE).
     */
    inner class Downloader {
        private val streams = HashMap<String, OutputStream>()
        private val uris = HashMap<String, Uri?>()
        private var counter = 0

        @JavascriptInterface
        fun start(name: String, mime: String): String {
            return try {
                val token = (counter++).toString()
                val safe = name.replace(Regex("[/\\\\]"), "_").ifEmpty { "file" }
                if (Build.VERSION.SDK_INT >= 29) {
                    val cv = ContentValues().apply {
                        put(MediaStore.Downloads.DISPLAY_NAME, safe)
                        if (mime.isNotEmpty()) put(MediaStore.Downloads.MIME_TYPE, mime)
                        put(MediaStore.Downloads.IS_PENDING, 1)
                    }
                    val uri = contentResolver.insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, cv) ?: return ""
                    val os = contentResolver.openOutputStream(uri) ?: return ""
                    uris[token] = uri; streams[token] = os
                } else {
                    val dir = Environment.getExternalStoragePublicDirectory(Environment.DIRECTORY_DOWNLOADS)
                    if (!dir.exists()) dir.mkdirs()
                    streams[token] = FileOutputStream(File(dir, safe)); uris[token] = null
                }
                token
            } catch (e: Exception) { "" }
        }

        @JavascriptInterface
        fun chunk(token: String, b64: String): Boolean {
            val os = streams[token] ?: return false
            return try { os.write(Base64.decode(b64, Base64.DEFAULT)); true } catch (e: Exception) { false }
        }

        @JavascriptInterface
        fun finish(token: String): Boolean {
            val os = streams.remove(token) ?: return false
            return try {
                os.flush(); os.close()
                if (Build.VERSION.SDK_INT >= 29) {
                    uris.remove(token)?.let {
                        contentResolver.update(it, ContentValues().apply { put(MediaStore.Downloads.IS_PENDING, 0) }, null, null)
                    }
                } else { uris.remove(token) }
                runOnUiThread { Toast.makeText(this@MainActivity, "Скачано в «Загрузки»", Toast.LENGTH_SHORT).show() }
                true
            } catch (e: Exception) { false }
        }

        @JavascriptInterface
        fun abort(token: String) {
            try { streams.remove(token)?.close() } catch (_: Exception) {}
            val uri = uris.remove(token)
            try { if (Build.VERSION.SDK_INT >= 29 && uri != null) contentResolver.delete(uri, null, null) } catch (_: Exception) {}
        }
    }

    inner class DeviceInfo {
        // Стабильный id устройства, ПЕРЕЖИВАЮЩИЙ переустановку APK (в отличие от localStorage,
        // который стирается при удалении приложения). ANDROID_ID привязан к устройству + ключу
        // подписи приложения, поэтому при обновлении пульта тем же ключом он не меняется —
        // редактор узнаёт устройство, повторный пайринг по коду не нужен.
        @JavascriptInterface
        fun deviceId(): String {
            return try {
                val id = Settings.Secure.getString(contentResolver, Settings.Secure.ANDROID_ID)
                if (id.isNullOrBlank()) "" else "a$id"
            } catch (_: Exception) {
                ""
            }
        }

        @JavascriptInterface
        fun systemInfo(): String {
            return try {
                JSONObject()
                    .put("appVersion", BuildConfig.VERSION_NAME)
                    .put("versionCode", BuildConfig.VERSION_CODE)
                    .put("sdkInt", Build.VERSION.SDK_INT)
                    .put("release", Build.VERSION.RELEASE ?: "")
                    .put("incremental", Build.VERSION.INCREMENTAL ?: "")
                    .put("manufacturer", Build.MANUFACTURER ?: "")
                    .put("brand", Build.BRAND ?: "")
                    .put("model", Build.MODEL ?: "")
                    .put("device", Build.DEVICE ?: "")
                    .put("product", Build.PRODUCT ?: "")
                    .put("hardware", Build.HARDWARE ?: "")
                    .put("board", Build.BOARD ?: "")
                    .put("supportedAbis", Build.SUPPORTED_ABIS.joinToString(","))
                    .put("relayUrl", BuildConfig.RELAY_URL)
                    .put("room", BuildConfig.ROOM)
                    .toString()
            } catch (_: Exception) {
                "{}"
            }
        }
    }
}
