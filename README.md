# ScanPdfApp

Aplicación móvil de escaneo de documentos construida con Expo/React Native. Incluye escaneo con cámara, edición (recorte, rotación, volteo), filtros, generación de PDF, modo DNI (frente/dorso en una sola página), y OCR para convertir imágenes a texto y guardar como DOCX.

## Características

- Escaneo con cámara (`expo-camera`) y previsualización en vivo.
- Editor: recorte rectangular, rotación, volteo y filtros (B/N, contraste, anti-moiré, documento).
- Generación de PDF (`expo-print`) y guardado/compartido (`expo-file-system`, `expo-sharing`).
- Modo DNI: captura frente y dorso y los coloca en una página A4.
- OCR: extracción de texto y exportación a DOCX (`docx`).
- Funciona en Android, iOS (con Expo Go para desarrollo) y Web (con límites en la cámara).

## Requisitos

- Node.js 18+
- npm 9+ o yarn
- Expo CLI (se instala con las dependencias del proyecto)
- Android: dispositivo o emulador (Android Studio) para probar y/o construir APK

## Instalación y ejecución

```bash
cd ScanPdfApp
npm install
npm run start
```

- Escaneá el QR con Expo Go en tu dispositivo.
- En Android Studio podés usar un emulador y seleccionar “Run on Android device/emulator”.

## Uso rápido

- Inicio → “Escanear PDF” para flujo normal de documento.
- “Modo DNI” → captura frente y dorso, auto-recorte y PDF A4 de una página.
- “OCR” → toma una foto o carga imagen en web y extrae texto; guardá como DOCX.
- En previsualización: aplicá filtros globales, calidad de PDF y guardá/compartí.

## Construir APK / AAB

### Opción recomendada: EAS Build (Managed)

EAS genera binarios firmados y listos para distribución.

1. Instalá EAS CLI:
   ```bash
   npm i -g eas-cli
   ```
2. Iniciá sesión:
   ```bash
   eas login
   ```
3. Inicializá el proyecto:
   ```bash
   eas init
   ```
4. Construí para Android:
   ```bash
   eas build -p android --profile production
   ```
   - Elegí “Generate new keystore” si aún no tenés.
   - Al finalizar, descargá el `.apk` o `.aab` desde el enlace de EAS.

### Opción local: Gradle (debug y release)

Esta opción precompila al proyecto nativo y usa Gradle.

1. Prebuild y correr en Android (genera debug APK):
   ```bash
   npm run android
   ```
   - Expo creará la carpeta `android/` y compilará un debug APK.
   - El archivo suele quedar en `android/app/build/outputs/apk/debug/app-debug.apk`.

2. Release APK firmado (manual):
   - Generá keystore:
     ```bash
     keytool -genkey -v -keystore scanpdfapp.keystore -alias scanpdfapp -keyalg RSA -keysize 2048 -validity 10000
     ```
   - Configurá firma en `android/app/build.gradle` y `android/gradle.properties` con rutas y contraseñas.
   - Compilá release:
     ```bash
     cd android
     .\gradlew.bat assembleRelease
     ```
   - El binario estará en `android/app/build/outputs/apk/release/app-release.apk`.

Nota: Para publicar en Google Play se recomienda usar `.aab` y EAS Build.

## Seguridad y claves

- No incluyas claves en `app.json` ni en el código. Usá variables de entorno (`EXPO_PUBLIC_*`) o secretos de EAS.
- Si hay claves en `expo.extra` (por ejemplo `cloudconvertApiKey`), reemplazalas por configuración segura antes de publicar builds.

## Tecnologías

- Expo SDK 54
- React Native 0.81
- Librerías: `expo-camera`, `expo-print`, `expo-file-system`, `expo-image-manipulator`, `expo-sharing`, `react-native-svg`, `docx`.

## Licencia y uso

Este proyecto es de código abierto y libre de uso bajo licencia MIT. Podés usarlo, modificarlo y distribuirlo, respetando los términos de la licencia.

Ver archivo `LICENSE`.

## Créditos

- Proyecto iniciado por The Kirv Studio
