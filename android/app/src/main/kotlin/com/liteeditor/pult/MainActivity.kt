package com.liteeditor.pult

import android.annotation.SuppressLint
import android.app.Activity
import android.os.Bundle
import android.view.ViewGroup
import android.webkit.WebView
import android.webkit.WebViewClient
import org.json.JSONObject

/**
 * Тонкая WebView-обёртка. Весь UI пульта — в assets/index.html + app.js (бандл
 * с xterm). Нативного кода минимум: создать WebView, включить JS/DOM-storage,
 * прокинуть конфиг (адрес релея/комната/токен из BuildConfig) в страницу и
 * загрузить локальный ассет. Дальше JS сам открывает WebSocket к релею.
 */
class MainActivity : Activity() {
    @SuppressLint("SetJavaScriptEnabled")
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)

        val web = WebView(this)
        web.layoutParams = ViewGroup.LayoutParams(
            ViewGroup.LayoutParams.MATCH_PARENT,
            ViewGroup.LayoutParams.MATCH_PARENT
        )
        setContentView(web)

        web.settings.javaScriptEnabled = true
        web.settings.domStorageEnabled = true
        WebView.setWebContentsDebuggingEnabled(true)

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

        web.loadUrl("file:///android_asset/index.html")
    }
}
