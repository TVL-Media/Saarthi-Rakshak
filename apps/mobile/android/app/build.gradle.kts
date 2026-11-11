import java.util.Properties

val localProps = Properties().apply {
    val f = rootProject.file("local.properties")
    if (f.exists()) f.inputStream().use { load(it) }
}

// The team's one signing key: android/key.properties (storeFile, storePassword, keyAlias, keyPassword),
// never in git. Every APK we hand out must be signed with this same key: Android only installs an
// update over the app when the key matches, and Play Protect distrusts the "Android Debug" key.
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
                // v2 for every phone we support; v3 so the key can be rotated later without a reinstall.
                enableV2Signing = true
                enableV3Signing = true
            }
        }
    }

    buildTypes {
        debug {
            manifestPlaceholders["usesCleartext"] = "true"
            // With the team key present, debug builds use it too, so a laptop build installs over
            // a tester's release build (and back) without uninstalling. Without it: the local debug key.
            if (releaseSigning != null) signingConfig = signingConfigs.getByName("release")
        }
        release {
            // Only ever the team key (checked below): never a quiet fallback to a debug key.
            if (releaseSigning != null) signingConfig = signingConfigs.getByName("release")
        }
    }
}

// A release APK without the team key would be signed with nobody's key (or a laptop's debug key):
// it could not update testers' installs and Play Protect blocks it. Stop with a clear message.
gradle.taskGraph.whenReady {
    val buildsRelease = allTasks.any { it.project == project && it.name.contains("Release") }
    if (!buildsRelease) return@whenReady
    val store = releaseSigning?.getProperty("storeFile")?.let { file(it) }
    if (releaseSigning == null || store == null || !store.exists()) {
        throw GradleException(
            "Release builds must be signed with the team key. Put android/key.properties " +
                "(storeFile, storePassword, keyAlias, keyPassword) and the keystore file on this computer " +
                "(see apps/mobile/README.md, \"Signing\"). Missing: " +
                (if (releaseSigning == null) "android/key.properties" else "keystore ${store?.path ?: "(storeFile not set)"}"),
        )
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

    // Unit tests of the engine's journey checks (run on the computer, no phone needed).
    testImplementation("junit:junit:4.13.2")
    testImplementation("org.json:json:20240303")
}
