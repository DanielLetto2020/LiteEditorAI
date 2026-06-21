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
val relayUrl: String = liteProps.getProperty("RELAY_URL", "") // дефолт пустой — приватный хост не хардкодим; задаётся в lite.properties (gitignored)
val room: String = liteProps.getProperty("ROOM", "default")
val token: String = liteProps.getProperty("TOKEN", "")

android {
    namespace = "com.liteeditor.pult"
    compileSdk = 34

    defaultConfig {
        applicationId = "com.liteeditor.pult"
        minSdk = 24
        targetSdk = 34
        versionCode = 56
        versionName = "0.60.0"

        buildConfigField("String", "RELAY_URL", "\"$relayUrl\"")
        buildConfigField("String", "ROOM", "\"$room\"")
        buildConfigField("String", "TOKEN", "\"$token\"")
    }

    // ПОСТОЯННЫЙ debug-keystore (lite-debug.keystore, коммитится в репо). Без него Gradle
    // генерирует свежий ключ при каждой сборке в эфемерном контейнере → у каждого APK другая
    // подпись → при переустановке Android выдаёт НОВЫЙ ANDROID_ID → пульт требует повторного
    // пайринга по коду. Фиксированный ключ → стабильный ANDROID_ID → одобрил устройство один
    // раз (хранится в БД релея по device_id), и переустановки/обновления пульта его не сбрасывают.
    signingConfigs {
        getByName("debug") {
            storeFile = file("lite-debug.keystore")
            storePassword = "android"
            keyAlias = "androiddebugkey"
            keyPassword = "android"
        }
    }

    buildTypes {
        debug { isMinifyEnabled = false }   // подпись — signingConfigs.debug (по умолчанию для debug-типа)
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
