import java.util.Properties

val localProps = Properties().apply {
    val f = rootProject.file("local.properties")
    if (f.exists()) f.inputStream().use { load(it) }
}

// Release signing key: android/key.properties (storeFile, storePassword, keyAlias, keyPassword).
val releaseSigning: Properties? = rootProject.file("key.properties").takeIf { it.exists() }?.let { f ->
    Properties().apply { f.inputStream().use { load(it) } }
}

plugins {
    id("com.android.application")
    // The Flutter Gradle Plugin must be applied after the Android and Kotlin Gradle plugins.
    id("dev.flutter.flutter-gradle-plugin")
}

android {
    namespace = "com.sarthirakshak.app"
    compileSdk = flutter.compileSdkVersion
    ndkVersion = flutter.ndkVersion

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    defaultConfig {
        // Must match the Android app registered in Firebase (push and phone OTP).
        applicationId = "com.sarthirakshak.app"
        // You can update the following values to match your application needs.
        // For more information, see: https://flutter.dev/to/review-gradle-config.
        minSdk = flutter.minSdkVersion
        targetSdk = flutter.targetSdkVersion
        // Uses the version code from pubspec.yaml. When using split APKs, 1000 * ABI_VERSION
        // is added automatically by Flutter. (https://developer.android.com/studio/build/configure-apk-splits#configure-APK-versions)
        // You can force using the value of versionCode by specifying the `-P force-version-code-ignoring-abi=true`
        // flag during build.
        versionCode = flutter.versionCode
        versionName = flutter.versionName
        // Google Maps key: MAPS_API_KEY in android/local.properties or the environment (never in git).
        manifestPlaceholders["mapsApiKey"] =
            (localProps.getProperty("MAPS_API_KEY") ?: System.getenv("MAPS_API_KEY") ?: "")
        // Plain http only for the laptop server in debug builds; release builds use HTTPS only.
        manifestPlaceholders["usesCleartext"] = "false"
    }

    signingConfigs {
        if (releaseSigning != null) {
            create("release") {
                storeFile = file(releaseSigning.getProperty("storeFile"))
                storePassword = releaseSigning.getProperty("storePassword")
                keyAlias = releaseSigning.getProperty("keyAlias")
                keyPassword = releaseSigning.getProperty("keyPassword")
            }
        }
    }

    buildTypes {
        debug {
            manifestPlaceholders["usesCleartext"] = "true"
        }
        release {
            // Our own release (upload) key from android/key.properties (never in git); without it,
            // the debug key so the build still works on any computer.
            signingConfig = if (releaseSigning != null) signingConfigs.getByName("release") else signingConfigs.getByName("debug")
            // Keeps what Voice SOS (Vosk + JNA) needs when the release build is shrunk.
            proguardFiles(getDefaultProguardFile("proguard-android-optimize.txt"), "proguard-rules.pro")
        }
    }
}

kotlin {
    compilerOptions {
        jvmTarget = org.jetbrains.kotlin.gradle.dsl.JvmTarget.JVM_17
    }
}

flutter {
    source = "../.."
}

dependencies {
    // Fused location for the safety engine (SOS and journey tracking).
    implementation("com.google.android.gms:play-services-location:21.3.0")
    // Phase 2: Voice SOS on the phone (offline phrase recognition, nothing leaves the phone).
    implementation("com.alphacephei:vosk-android:0.3.47")
    implementation("net.java.dev.jna:jna:5.13.0@aar")
    implementation("androidx.core:core-ktx:1.13.1")

    // Unit tests of the engine's journey checks (run on the computer, no phone needed).
    testImplementation("junit:junit:4.13.2")
    testImplementation("org.json:json:20240303")
}
