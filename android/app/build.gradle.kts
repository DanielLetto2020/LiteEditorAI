import java.io.FileInputStream
import java.util.Properties

plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

// lite.properties (gitignored) — адрес релея, код комнаты и токен пейринга.
// Меняешь токен/комнату → пересобираешь APK. Дефолты — на случай отсутствия файла.
val liteProps = Properties().apply {
    val f = rootProject.file("lite.properties")
    if (f.exists()) load(FileInputStream(f))
}
val relayUrl: String = liteProps.getProperty("RELAY_URL", "wss://lite.codecopy.ru/ws")
val room: String = liteProps.getProperty("ROOM", "default")
val token: String = liteProps.getProperty("TOKEN", "")

android {
    namespace = "com.liteeditor.pult"
    compileSdk = 34

    defaultConfig {
        applicationId = "com.liteeditor.pult"
        minSdk = 24
        targetSdk = 34
        versionCode = 43
        versionName = "0.43.0"

        buildConfigField("String", "RELAY_URL", "\"$relayUrl\"")
        buildConfigField("String", "ROOM", "\"$room\"")
        buildConfigField("String", "TOKEN", "\"$token\"")
    }

    buildTypes {
        debug { isMinifyEnabled = false }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    kotlinOptions {
        jvmTarget = "17"
    }

    buildFeatures {
        buildConfig = true
    }
}

dependencies {
    // Пусто: используем только framework WebView + android.app.Activity. Минимум зависимостей.
}
