/*
 ScanPdf — Aplicación de escaneo de documentos con:
 - Flujo de cámara y previsualización
 - Modo Documento y Modo DNI (frente/dorso)
 - Filtros de imagen y editor con recorte/rotación/volteo
 - Generación y guardado/compartido de PDF
 - OCR a texto y creación de DOCX
 by The Kirv Studio
*/
import React, { useEffect, useRef, useState } from 'react';
import { StatusBar } from 'expo-status-bar';
import { StyleSheet, Text, View, TouchableOpacity, Platform, Image, Alert, ActivityIndicator, Modal, PanResponder, ScrollView, TextInput, Dimensions, Linking } from 'react-native';
import { SafeAreaProvider, SafeAreaView } from 'react-native-safe-area-context';
import { LinearGradient } from 'expo-linear-gradient';
import { BlurView } from 'expo-blur';
import { Ionicons } from '@expo/vector-icons';
import { Camera, CameraType, CameraView } from 'expo-camera'; 
import * as Print from 'expo-print';
// Usa la API legacy para evitar el warning de deprecación y mantener compatibilidad con SDK 54
import * as FileSystem from 'expo-file-system/legacy';
import * as Sharing from 'expo-sharing';
import * as ImageManipulator from 'expo-image-manipulator';
import Svg, { Rect, Line } from 'react-native-svg';
import * as IntentLauncher from 'expo-intent-launcher';
import Slider from '@react-native-community/slider';
import ConvertDocument from './components/ConvertDocument';
import { Document, Packer, Paragraph, TextRun } from 'docx';
import { ocrExtractText } from './utils/ocrSpace';

const isWeb = typeof document !== 'undefined';

type FilterType = 'none' | 'grayscale' | 'contrast' | 'antimoire' | 'enhance' | 'document';

const getCssFilter = (f: 'none' | 'grayscale' | 'contrast' | 'antimoire' | 'enhance' | 'document') => {
  switch (f) {
    case 'grayscale':
      return 'grayscale(1)';
    case 'contrast':
      return 'contrast(1.25) brightness(1.05)';
    case 'antimoire':
      return 'blur(0.6px) contrast(1.04)';
    case 'enhance':
      return 'contrast(1.12) brightness(1.06) saturate(1.06)';
    case 'document':
      // Filtro para documentos: alto contraste sin aplastar negros
      return 'grayscale(1) contrast(2) brightness(1.1)';
    default:
      return '';
  }
};

/**
 * Componente principal de la app.
 * Administra los modos de uso (inicio, cámara, previsualización),
 * el ciclo de vida de fotos y sus ediciones, y las acciones de PDF/OCR.
 */
export default function App() {
  const [mode, setMode] = useState<'home' | 'camera' | 'preview'>('home');
  const [hasPermission, setHasPermission] = useState<boolean | null>(null);
  const [photos, setPhotos] = useState<string[]>([]);
  const [photoFilters, setPhotoFilters] = useState<Record<string, 'none' | 'grayscale' | 'contrast' | 'antimoire' | 'enhance' | 'document'>>({});
  const [creatingPdf, setCreatingPdf] = useState(false);
  const cameraRef = useRef<CameraView | null>(null);
  const [editingUri, setEditingUri] = useState<string | null>(null);
  const [pdfName, setPdfName] = useState<string>('scanpdf');
  const [pdfQuality, setPdfQuality] = useState<'light' | 'medium' | 'high'>('light');
  const [pdfPreviewHtml, setPdfPreviewHtml] = useState<string | null>(null);
  const [savingPdf, setSavingPdf] = useState<boolean>(false);
  const WebViewNative = (require('react-native-webview').WebView as any);
  const [savedPdfs, setSavedPdfs] = useState<{ name: string; uri: string; size?: number; mtime?: number }[]>([]);
  // Modo DNI: captura exactamente dos fotos (frente y dorso) con flujo de escáner
  const [dniMode, setDniMode] = useState<boolean>(false);
  // Filtro elegido para DNI: 'none' (sin filtro) o 'grayscale' (blanco y negro)
  const [dniFilter, setDniFilter] = useState<'none' | 'grayscale'>('none');
  const [dniSessionStartIndex, setDniSessionStartIndex] = useState<number | null>(null);

  // Normaliza timestamps en segundos a milisegundos para consistencia entre plataformas
  const normalizeMtime = (t?: number) => {
    if (!t) return undefined;
    return t < 1e11 ? t * 1000 : t; // si es en segundos, conviértelo a ms
  };

  const loadSavedPdfs = async () => {
    try {
      // @ts-ignore
      const dir = FileSystem.documentDirectory as string | null;
      if (!dir) return;
      // @ts-ignore
      const names: string[] = await FileSystem.readDirectoryAsync(dir);
      const pdfNames = names.filter((n) => n.toLowerCase().endsWith('.pdf'));
      const entries = await Promise.all(
        pdfNames.map(async (name) => {
          const uri = `${dir}${name}`;
          // @ts-ignore
          const info = await FileSystem.getInfoAsync(uri, { size: true });
          // @ts-ignore
          const rawMtime = info.modificationTime ?? info.mtime ?? undefined;
          const mtime = normalizeMtime(rawMtime);
          return { name, uri, size: info.size, mtime } as { name: string; uri: string; size?: number; mtime?: number };
        })
      );
      entries.sort((a, b) => (b.mtime ?? 0) - (a.mtime ?? 0));
      setSavedPdfs(entries);
    } catch {}
  };
  const [containerSize, setContainerSize] = useState<{ width: number; height: number } | null>(null);
  const [imageSize, setImageSize] = useState<{ width: number; height: number } | null>(null);
  const [displayRect, setDisplayRect] = useState<{ x: number; y: number; width: number; height: number } | null>(null);
  // Eliminado soporte de polígono; usamos solo recorte rectangular
  const [cropRect, setCropRect] = useState<{ x: number; y: number; width: number; height: number } | null>(null);
  const [dragging, setDragging] = useState<null | 'tl' | 'tr' | 'bl' | 'br'>(null);
  // Sin vértices libres en modo rectángulo
  const dragStartRef = useRef<{ x: number; y: number; width: number; height: number } | null>(null);
  const [liveRotation, setLiveRotation] = useState<number>(0);
  const [pendingFlip, setPendingFlip] = useState<boolean>(false);
  const [returnToPreviewAfterShot, setReturnToPreviewAfterShot] = useState<boolean>(false);
  const [lastAddedUri, setLastAddedUri] = useState<string | null>(null);
  const previewScrollRef = useRef<ScrollView | null>(null);
  const [toastMsg, setToastMsg] = useState<string | null>(null);
  const toastTimerRef = useRef<any>(null);
  const [draggingUri, setDraggingUri] = useState<string | null>(null);
  const [dragDy, setDragDy] = useState<number>(0);
  const [dragStartIndex, setDragStartIndex] = useState<number>(-1);
  const [switchingToPreview, setSwitchingToPreview] = useState<boolean>(false);
  // Cámara: estado de UI
  const [facing, setFacing] = useState<'back' | 'front'>('back');
  const [flash, setFlash] = useState<'off' | 'on' | 'auto'>('off');
  const [showGrid, setShowGrid] = useState<boolean>(true);
  const [docMode, setDocMode] = useState<boolean>(false);
  const [docPage, setDocPage] = useState<'A4' | 'Letter'>('A4');
  const [autoCropAfterCapture, setAutoCropAfterCapture] = useState<boolean>(true);
  const [pendingAutoCropUri, setPendingAutoCropUri] = useState<string | null>(null);
  const [docReviewMode, setDocReviewMode] = useState<boolean>(true);
  const [returnToCameraOnSave, setReturnToCameraOnSave] = useState<boolean>(false);
  // Marcar imágenes que ya fueron recortadas para no aplicar recortes iniciales automáticos al reabrir
  const [croppedUris, setCroppedUris] = useState<Record<string, boolean>>({});
  // Guardar recortes por foto en coordenadas de píxeles originales
  const [photoCrops, setPhotoCrops] = useState<Record<string, { originX: number; originY: number; width: number; height: number }>>({});
  // Editor: historial para deshacer/rehacer
  type EditorSnapshot = {
    uri: string;
    filterKey: FilterType | null;
    liveRotation: number;
    pendingFlip: boolean;
    cropRect: { x: number; y: number; width: number; height: number } | null;
    aspectIdx: number;
  };
  const [history, setHistory] = useState<EditorSnapshot[]>([]);
  const [historyIndex, setHistoryIndex] = useState<number>(-1);
  // Sensibilidad de reordenamiento más alta para gestos cortos
  const ITEM_HEIGHT = 180;
  const panResponder = useRef(
    PanResponder.create({
      onStartShouldSetPanResponder: () => !!draggingUri,
      onMoveShouldSetPanResponder: () => !!draggingUri,
      onStartShouldSetPanResponderCapture: () => !!draggingUri,
      onMoveShouldSetPanResponderCapture: () => !!draggingUri,
      onPanResponderMove: (_, gesture) => {
        setDragDy(gesture.dy);
      },
      onPanResponderTerminationRequest: () => false,
      onPanResponderRelease: () => {
        finalizeDrag();
      },
      onPanResponderTerminate: () => {
        finalizeDrag();
      },
    })
  ).current;
  const finalizeDrag = () => {
    if (!draggingUri || dragStartIndex < 0) {
      setDraggingUri(null);
      setDragDy(0);
      setDragStartIndex(-1);
      return;
    }
    // Permitir movimientos con desplazamientos más cortos
    const deltaIndex = Math.round(dragDy / 140);
    const targetIndex = clamp(dragStartIndex + deltaIndex, 0, photos.length - 1);
    setPhotos((prev) => {
      const from = prev.indexOf(draggingUri);
      if (from < 0) return prev;
      if (from === targetIndex) return prev;
      const next = [...prev];
      next.splice(from, 1);
      next.splice(targetIndex, 0, draggingUri);
      return next;
    });
    setDraggingUri(null);
    setDragDy(0);
    setDragStartIndex(-1);
    showToast('Orden actualizado');
  };
  const showToast = (msg: string) => {
    setToastMsg(msg);
    if (toastTimerRef.current) clearTimeout(toastTimerRef.current);
    toastTimerRef.current = setTimeout(() => setToastMsg(null), 1500);
  };
  const aspectRatios = [
    { label: 'Libre', value: null as number | null },
    { label: '1:1', value: 1 },
    { label: '3:2', value: 3 / 2 },
    { label: '4:3', value: 4 / 3 },
    { label: '16:9', value: 16 / 9 },
  ];
  const [aspectIdx, setAspectIdx] = useState<number>(0);

  // Actualiza el filtro para una foto específica
  const setFilterForPhoto = (uri: string, filter: FilterType) => {
    setPhotoFilters((prev) => ({ ...prev, [uri]: filter }));
  };

  // Aplica un filtro a todas las fotos del documento
  const setFilterForAllPhotos = (filter: FilterType) => {
    setPhotoFilters((prev) => {
      const next = { ...prev };
      photos.forEach((u) => { next[u] = filter; });
      return next;
    });
  };
  const [dialSize, setDialSize] = useState<{ w: number; h: number } | null>(null);
  const dialResponder = PanResponder.create({
    onStartShouldSetPanResponder: () => true,
    onPanResponderMove: (evt) => {
      if (!dialSize) return;
      const { locationX, locationY } = evt.nativeEvent as any;
      const cx = dialSize.w / 2;
      const cy = dialSize.h / 2;
      const angleRad = Math.atan2(locationY - cy, locationX - cx);
      let angle = Math.round((angleRad * 180) / Math.PI);
      angle = Math.max(-180, Math.min(180, angle));
      setLiveRotation(angle);
    },
    onPanResponderRelease: () => {},
  });

  const requestPermissions = async () => {
    const { status } = await Camera.requestCameraPermissionsAsync();
    setHasPermission(status === 'granted');
    if (status !== 'granted') {
      Alert.alert('Permiso requerido', 'La app necesita acceso a la cámara.');
    }
  };

  // Iniciar una nueva sesión de documento: limpiar fotos, filtros y estado relacionado
  const startNewDocumentSession = () => {
    setPhotos([]);
    setPhotoFilters({});
    setPdfPreviewHtml(null);
    setEditingUri(null);
    setLastAddedUri(null);
    setDraggingUri(null);
    setDragDy(0);
    setDragStartIndex(-1);
    setHistory([]);
    setHistoryIndex(-1);
    setCroppedUris({});
    setPhotoCrops({});
    setPendingAutoCropUri(null);
    setDocMode(false);
    setOcrMode(false);
    setDniMode(false);
    setDniFilter('none');
    setDniSessionStartIndex(null);
    setReturnToCameraOnSave(false);
    setLiveRotation(0);
    setPendingFlip(false);
    setCropRect(null);
    setImageSize(null);
    setPdfName('scanpdf');
  };

  const beginScan = async () => {
    await requestPermissions();
    if (hasPermission) {
      // Nueva sesión para evitar reutilizar fotos/nombre del documento anterior
      startNewDocumentSession();
      // Asegurar que el escaneo normal no arrastre estado de Modo DNI
      setDniMode(false);
      setDniSessionStartIndex(null);
      setOcrMode(false);
      setMode('camera');
    }
  };

  // Iniciar flujo de captura para Modo DNI (usa escáner con auto-recorte)
  const beginDniMode = async () => {
    await requestPermissions();
    // Activar características del escáner de documentos
    // Nueva sesión para separar del documento anterior
    startNewDocumentSession();
    setDocMode(true);
    setAutoCropAfterCapture(true);
    setDocReviewMode(true);
    setDniMode(true);
    setDniSessionStartIndex(photos.length);
    showToast('Modo DNI: captura frente y dorso (usa el teléfono en horizontal)');
    setMode('camera');
  };

  // Iniciar flujo de OCR (foto -> texto -> DOCX)
  const beginOcr = async () => {
    if (isWeb) {
      try {
        // Flujo Web: elegir imagen desde el disco y procesar OCR sin cámara
        const file = await pickOcrFileWeb();
        if (!file) return;
        setOcrLoading(true);
        let text = await ocrExtractText({ file, language: ocrLanguage });
        if (!text || text.trim().length < 5) {
          const altLang = ocrLanguage === 'spa' ? 'eng' : 'spa';
          text = await ocrExtractText({ file, language: altLang });
        }
        setOcrText(text || '');
        setShowOcrResult(true);
      } catch (e) {
        Alert.alert('OCR', 'No se pudo procesar la imagen. Prueba con otra foto o cambia el idioma.');
      } finally {
        setOcrLoading(false);
      }
    } else {
      await requestPermissions();
      if (hasPermission) {
        // Nueva sesión para OCR
        startNewDocumentSession();
        setDniMode(false);
        setDniSessionStartIndex(null);
        // Desactivar modos de documento para evitar recortes automáticos
        setDocMode(false);
        setAutoCropAfterCapture(false);
        setDocReviewMode(false);
        setOcrMode(true);
        showToast(`OCR (${ocrLanguage === 'spa' ? 'ES' : 'EN'}): toma una foto nítida del texto`);
        setMode('camera');
      }
    }
  };

  // Web: selector de archivo para OCR
  const pickOcrFileWeb = async (): Promise<File | null> => {
    return new Promise((resolve) => {
      try {
        const input = document.createElement('input');
        input.type = 'file';
        input.accept = 'image/*';
        input.style.display = 'none';
        input.onchange = () => {
          const file = input.files && input.files[0] ? input.files[0] : null;
          resolve(file);
          document.body.removeChild(input);
        };
        document.body.appendChild(input);
        input.click();
      } catch {
        resolve(null);
      }
    });
  };

  const takePhoto = async () => {
    try {
      if (cameraRef.current) {
        const result = await cameraRef.current.takePictureAsync({ quality: 0.8, skipProcessing: true });
      if (result?.uri) {
        setPhotos((prev) => [...prev, result.uri]);
          if (docMode) {
            // En modo DNI permitir elegir filtro; en escáner normal mantener 'document'
            if (dniMode) {
              setPhotoFilters((prev) => ({ ...prev, [result.uri]: dniFilter }));
            } else {
              setPhotoFilters((prev) => ({ ...prev, [result.uri]: 'document' }));
            }
          }
          setLastAddedUri(result.uri);
          showToast('Foto agregada');
          // Auto recorte en modo documento (con revisión opcional)
          if (docMode && autoCropAfterCapture) {
            setPendingAutoCropUri(result.uri);
            setEditingUri(result.uri);
            setMode('preview');
            setReturnToPreviewAfterShot(false);
            setReturnToCameraOnSave(true);
            showToast(docReviewMode ? 'Detectando página…' : 'Detectando y recortando…');
          } else if (ocrMode) {
            try {
              setOcrLoading(true);
              let text = await ocrExtractText({ uri: result.uri, fileName: 'photo.jpg', mimeType: 'image/jpeg', language: ocrLanguage });
              if (!text || text.trim().length < 5) {
                const altLang = ocrLanguage === 'spa' ? 'eng' : 'spa';
                text = await ocrExtractText({ uri: result.uri, fileName: 'photo.jpg', mimeType: 'image/jpeg', language: altLang });
              }
              setOcrText(text || '');
              setShowOcrResult(true);
              setMode('home');
            } catch (e) {
              Alert.alert('OCR', 'No se pudo extraer texto de la foto. Prueba con mejor iluminación, enfoque o cambia el idioma (Español/Inglés).');
            } finally {
              setOcrMode(false);
              setOcrLoading(false);
              setPhotos((prev) => prev.filter((u) => u !== result.uri));
            }
          } else if (returnToPreviewAfterShot) {
            setMode('preview');
            setReturnToPreviewAfterShot(false);
          }
        }
      }
    } catch (e) {
      Alert.alert('Error', 'No se pudo tomar la foto.');
    }
  };

  // Ejecutar auto recorte cuando la imagen y el layout están listos en el editor
  useEffect(() => {
    const runAutoCrop = async () => {
      if (!pendingAutoCropUri || !editingUri || editingUri !== pendingAutoCropUri) return;
      if (!displayRect || !imageSize) return;
      try {
        // Bloquear múltiples ejecuciones concurrentes antes de iniciar
        const sourceUri = editingUri;
        setPendingAutoCropUri(null);
        // Recorte con aspecto A4/Letter, siguiendo exactamente el marco de cámara (80% ancho, máx 72% alto)
        const a4Portrait = 210 / 297;
        const a4Landscape = 297 / 210;
        const letterPortrait = 8.5 / 11;
        const letterLandscape = 11 / 8.5;
        const pageAspect = docPage === 'A4' ? a4Portrait : letterPortrait;
        // Usar mismas reglas del overlay de cámara: 80% del ancho disponible y limitar altura a 72%
        let w = displayRect.width * 0.8;
        let h = w / pageAspect;
        const maxH = displayRect.height * 0.72;
        if (h > maxH) {
          h = maxH;
          w = h * pageAspect;
        }
        const x = displayRect.x + (displayRect.width - w) / 2;
        const y = displayRect.y + (displayRect.height - h) / 2;
        setCropRect({ x, y, width: w, height: h });
        // En modo revisión: NO recortar automáticamente; dejar el rectángulo centrado para que el usuario ajuste
        if (docReviewMode) {
          // Sin acciones adicionales: evitar “zoom” tras la captura
        } else {
          await saveEdits();
          showToast('Recorte automático aplicado');
          setMode('camera');
        }
      } catch (e) {
        showToast('No se pudo aplicar auto recorte');
      }
    };
    runAutoCrop();
  }, [editingUri, displayRect, imageSize, pendingAutoCropUri, docReviewMode, docPage]);

  const goToPreview = () => {
    if (photos.length > 0) {
      setSwitchingToPreview(true);
      try {
        if (cameraRef.current && !isWeb) {
          // Pausar preview de cámara para evitar bloqueos visuales al desmontar
          // @ts-ignore
          cameraRef.current.pausePreview?.();
        }
      } catch {}
      setTimeout(() => {
        setMode('preview');
        setSwitchingToPreview(false);
      }, 120);
    } else {
      Alert.alert('Sin fotos', 'Toma al menos una foto para previsualizar.');
    }
  };

  useEffect(() => {
    if (mode === 'home') {
      loadSavedPdfs();
    }
  }, [mode]);

  const removePhoto = (uri: string) => {
    setPhotos((prev) => prev.filter((u) => u !== uri));
    setPhotoFilters((prev) => {
      const { [uri]: _omit, ...rest } = prev;
      return rest;
    });
    // Limpiar estados asociados (recorte y bandera de recortado)
    setPhotoCrops((prev) => {
      const { [uri]: _omit, ...rest } = prev;
      return rest;
    });
    setCroppedUris((prev) => {
      const { [uri]: _omit, ...rest } = prev;
      return rest;
    });
    if (lastAddedUri === uri) setLastAddedUri(null);
  };

  const startDrag = (uri: string) => {
    const idx = photos.indexOf(uri);
    if (idx >= 0) {
      setDraggingUri(uri);
      setDragStartIndex(idx);
      setDragDy(0);
    }
  };

  useEffect(() => {
    if (mode === 'preview' && lastAddedUri) {
      setTimeout(() => {
        previewScrollRef.current?.scrollTo({ y: 0, animated: true });
      }, 100);
    }
  }, [mode, lastAddedUri]);

  const movePhoto = (uri: string, dir: 'up' | 'down') => {
    setPhotos((prev) => {
      const idx = prev.indexOf(uri);
      const target = dir === 'up' ? idx - 1 : idx + 1;
      if (idx < 0 || target < 0 || target >= prev.length) return prev;
      const next = [...prev];
      const [item] = next.splice(idx, 1);
      next.splice(target, 0, item);
      return next;
    });
  };

  const openEditor = (uri: string) => {
    setEditingUri(uri);
    setCropRect(null);
    setImageSize(null);
  };

  // Inicializar historial al abrir editor sobre una imagen
  useEffect(() => {
    if (!editingUri) return;
    const snap: EditorSnapshot = {
      uri: editingUri,
      filterKey: photoFilters[editingUri] ?? null,
      liveRotation,
      pendingFlip,
      cropRect,
      aspectIdx,
    };
    setHistory([snap]);
    setHistoryIndex(0);
  }, [editingUri]);

  const applySnapshot = (s: EditorSnapshot) => {
    if (!editingUri) return;
    setLiveRotation(s.liveRotation);
    setPendingFlip(s.pendingFlip);
    setCropRect(s.cropRect);
    setAspectIdx(s.aspectIdx);
    setPhotoFilters((prev) => {
      const next = { ...prev };
      if (s.filterKey && editingUri) {
        next[editingUri] = s.filterKey;
      } else if (editingUri && next[editingUri]) {
        const { [editingUri]: _omit, ...rest } = next;
        return rest as typeof next;
      }
      return next;
    });
  };

  const pushHistory = () => {
    if (!editingUri) return;
    const snap: EditorSnapshot = {
      uri: editingUri,
      filterKey: photoFilters[editingUri] ?? null,
      liveRotation,
      pendingFlip,
      cropRect,
      aspectIdx,
    };
    setHistory((prev) => {
      const base = prev.slice(0, historyIndex + 1);
      const next = [...base, snap];
      setHistoryIndex(next.length - 1);
      return next;
    });
  };

  const getPrevIndex = () => {
    for (let i = historyIndex - 1; i >= 0; i--) {
      if (history[i].uri === editingUri) return i;
    }
    return -1;
  };
  const getNextIndex = () => {
    for (let i = historyIndex + 1; i < history.length; i++) {
      if (history[i].uri === editingUri) return i;
    }
    return -1;
  };
  const canUndo = () => getPrevIndex() >= 0;
  const canRedo = () => getNextIndex() >= 0;
  const handleUndo = () => {
    const idx = getPrevIndex();
    if (idx >= 0) {
      applySnapshot(history[idx]);
      setHistoryIndex(idx);
    }
  };
  const handleRedo = () => {
    const idx = getNextIndex();
    if (idx >= 0) {
      applySnapshot(history[idx]);
      setHistoryIndex(idx);
    }
  };

  const onEditorLayout = (e: any) => {
    const { width, height } = e.nativeEvent.layout;
    setContainerSize({ width, height });
  };

  const onImageLoad = (w: number, h: number) => {
    setImageSize({ width: w, height: h });
  };

  // Asegura cálculo de tamaño de imagen al abrir el editor también en nativo (FilteredPreview no dispara onLoad)
  useEffect(() => {
    if (!editingUri) return;
    Image.getSize(editingUri, (w, h) => onImageLoad(w, h), () => {});
  }, [editingUri]);

  const clamp = (val: number, min: number, max: number) => Math.max(min, Math.min(max, val));
  
  // Marco de página (A4/Letter) para centrar la imagen dentro del editor
  const [pageRect, setPageRect] = useState<{ x: number; y: number; width: number; height: number } | null>(null);

  // Asegurar que el recorte siempre quede dentro de la imagen
  const boundCrop = (imgW: number, imgH: number, originX: number, originY: number, width: number, height: number) => {
    const ox = clamp(originX, 0, imgW);
    const oy = clamp(originY, 0, imgH);
    const maxW = Math.max(1, Math.min(width, imgW - ox));
    const maxH = Math.max(1, Math.min(height, imgH - oy));
    return {
      originX: Math.round(ox),
      originY: Math.round(oy),
      width: Math.round(maxW),
      height: Math.round(maxH),
    };
  };

  // Calcular el marco A4/Letter centrado y usarlo como área visible; la imagen se ajusta en modo "cover" dentro de este marco
  useEffect(() => {
    if (!containerSize || !imageSize) return;
    const a4Portrait = 210 / 297;
    const letterPortrait = 8.5 / 11;
    const pageAspect = docPage === 'A4' ? a4Portrait : letterPortrait;

    // Calcular el rectángulo de página (A4/Letter) máximo dentro del contenedor y centrado
    const containerAspect = containerSize.width / containerSize.height;
    let pageW: number, pageH: number;
    if (containerAspect < pageAspect) {
      pageW = containerSize.width;
      pageH = pageW / pageAspect;
    } else {
      pageH = containerSize.height;
      pageW = pageH * pageAspect;
    }
    const pageX = (containerSize.width - pageW) / 2;
    const pageY = (containerSize.height - pageH) / 2;
    const page = { x: pageX, y: pageY, width: pageW, height: pageH };
    setPageRect(page);
    // El área visible para la interacción debe coincidir con el área REAL de la imagen (resizeMode="contain")
    if (imageSize) {
      const scale = Math.min(page.width / imageSize.width, page.height / imageSize.height);
      const contentW = imageSize.width * scale;
      const contentH = imageSize.height * scale;
      const contentX = page.x + (page.width - contentW) / 2;
      const contentY = page.y + (page.height - contentH) / 2;
      setDisplayRect({ x: contentX, y: contentY, width: contentW, height: contentH });
    } else {
      // Hasta conocer tamaño de la imagen, usar el marco de página provisionalmente
      setDisplayRect(page);
    }
    // Inicializar cropRect al abrir editor
    if (!cropRect && editingUri) {
      const savedCrop = photoCrops[editingUri];
      if (savedCrop && displayRect) {
        // Traducir recorte guardado (píxeles originales) a pantalla en modo "contain"
        const scale = Math.min(displayRect.width / imageSize.width, displayRect.height / imageSize.height);
        const offsetX = displayRect.x;
        const offsetY = displayRect.y;
        setCropRect({
          x: offsetX + savedCrop.originX * scale,
          y: offsetY + savedCrop.originY * scale,
          width: savedCrop.width * scale,
          height: savedCrop.height * scale,
        });
        return;
      }
      // Si no hay recorte guardado, usar un rectángulo centrado como el marco de modo documento sobre displayRect (área real de imagen)
      if (!croppedUris[editingUri] && displayRect) {
        const a4Portrait2 = 210 / 297;
        const letterPortrait2 = 8.5 / 11;
        const a4Landscape2 = 297 / 210;
        const letterLandscape2 = 11 / 8.5;
        const useLandscape2 = dniMode === true;
        const pageAspect2 = docPage === 'A4'
          ? (useLandscape2 ? a4Landscape2 : a4Portrait2)
          : (useLandscape2 ? letterLandscape2 : letterPortrait2);
        let w = displayRect.width * 0.8;
        let h = w / pageAspect2;
        const maxH = displayRect.height * 0.72;
        if (h > maxH) {
          h = maxH;
          w = h * pageAspect2;
        }
        const cx = displayRect.x + (displayRect.width - w) / 2;
        const cy = displayRect.y + (displayRect.height - h) / 2;
        setCropRect({ x: cx, y: cy, width: w, height: h });
      }
    }
  }, [containerSize, imageSize, editingUri, croppedUris, cropRect, photoCrops, docPage, displayRect]);

  // Garantizar que el recorte no exceda el área visible de la imagen
  useEffect(() => {
    if (!cropRect || !displayRect) return;
    let { x, y, width, height } = cropRect;
    // Limitar tamaño a lo que se puede mostrar
    width = Math.min(width, displayRect.width);
    height = Math.min(height, displayRect.height);
    // Mantener dentro de los límites
    x = clamp(x, displayRect.x, displayRect.x + displayRect.width - width);
    y = clamp(y, displayRect.y, displayRect.y + displayRect.height - height);
    // Sólo actualizar si cambió algo
    if (
      x !== cropRect.x ||
      y !== cropRect.y ||
      width !== cropRect.width ||
      height !== cropRect.height
    ) {
      setCropRect({ x, y, width, height });
    }
  }, [cropRect, displayRect]);

  const makeHandleResponder = (corner: 'tl' | 'tr' | 'bl' | 'br') =>
    PanResponder.create({
      onStartShouldSetPanResponder: () => true,
      onPanResponderGrant: () => setDragging(corner),
      onPanResponderMove: (_, gesture) => {
        if (!cropRect || !displayRect) return;
        let { x, y, width, height } = cropRect;
        const dx = gesture.dx;
        const dy = gesture.dy;
        if (corner === 'tl') {
          const nx = clamp(x + dx, displayRect.x, x + width - 40);
          const ny = clamp(y + dy, displayRect.y, y + height - 40);
          width = width - (nx - x);
          height = height - (ny - y);
          x = nx; y = ny;
        } else if (corner === 'tr') {
          const ny = clamp(y + dy, displayRect.y, y + height - 40);
          const nRight = clamp(x + width + dx, x + 40, displayRect.x + displayRect.width);
          width = nRight - x;
          height = height - (ny - y);
          y = ny;
        } else if (corner === 'bl') {
          const nx = clamp(x + dx, displayRect.x, x + width - 40);
          const nBottom = clamp(y + height + dy, y + 40, displayRect.y + displayRect.height);
          height = nBottom - y;
          width = width - (nx - x);
          x = nx;
        } else if (corner === 'br') {
          const nRight = clamp(x + width + dx, x + 40, displayRect.x + displayRect.width);
          const nBottom = clamp(y + height + dy, y + 40, displayRect.y + displayRect.height);
          width = nRight - x;
          height = nBottom - y;
        }
        setCropRect({ x, y, width, height });
      },
      onPanResponderRelease: () => setDragging(null),
    });

  const rectResponder = PanResponder.create({
    onStartShouldSetPanResponder: () => true,
    onPanResponderGrant: () => {
      if (cropRect) dragStartRef.current = { ...cropRect };
    },
    onPanResponderMove: (_, gesture) => {
      if (!dragStartRef.current || !displayRect) return;
      const start = dragStartRef.current;
      const nx = clamp(start.x + gesture.dx, displayRect.x, displayRect.x + displayRect.width - start.width);
      const ny = clamp(start.y + gesture.dy, displayRect.y, displayRect.y + displayRect.height - start.height);
      setCropRect({ x: nx, y: ny, width: start.width, height: start.height });
    },
    onPanResponderRelease: () => {
      dragStartRef.current = null;
    },
  });

  const tlResponder = makeHandleResponder('tl');
  const trResponder = makeHandleResponder('tr');
  const blResponder = makeHandleResponder('bl');
  const brResponder = makeHandleResponder('br');

  // Eliminados responders del polígono

  const saveCrop = async () => {
    if (!editingUri || !imageSize || !displayRect) return;
    if (!cropRect) return;
    // Mapeo para imagen en modo "contain": displayRect representa el área real de la imagen
    const scaleX = imageSize.width / displayRect.width;
    const scaleY = imageSize.height / displayRect.height;
    const originX = Math.round((cropRect.x - displayRect.x) * scaleX);
    const originY = Math.round((cropRect.y - displayRect.y) * scaleY);
    const width = Math.round(cropRect.width * scaleX);
    const height = Math.round(cropRect.height * scaleY);
    const safeCrop = boundCrop(imageSize.width, imageSize.height, originX, originY, width, height);
    try {
      const { uri } = await ImageManipulator.manipulateAsync(
        editingUri,
        [{ crop: safeCrop }],
        { compress: 0.9, format: ImageManipulator.SaveFormat.JPEG }
      );
      setPhotos((prev) => {
        const idx = prev.indexOf(editingUri);
        if (idx >= 0) {
          const next = [...prev];
          next[idx] = uri;
          return next;
        }
        return [...prev, uri];
      });

      // Conservar filtro asignado al actualizar la URI tras recorte
      setPhotoFilters((prev) => {
        const current = prev[editingUri];
        if (current) {
          const { [editingUri]: _omit, ...rest } = prev;
          return { ...rest, [uri]: current };
        }
        return prev;
      });
      // Guardar recorte aplicado en píxeles originales para reabrir
      setPhotoCrops((prev) => {
        const { [editingUri]: _omit, ...rest } = prev;
        return { ...rest, [uri]: safeCrop };
      });
      // Marcar nueva URI como recortada por la app
      setCroppedUris((prev) => {
        const { [editingUri]: _omit, ...rest } = prev;
        return { ...rest, [uri]: true };
      });
      setEditingUri(null);
    } catch (e) {
      Alert.alert('Error', 'No se pudo aplicar el recorte.');
    }
  };

  // Rotar imagen con fallback ante errores
  const rotateImage = async (angle: number) => {
    if (!editingUri) return;
    try {
      const { uri } = await ImageManipulator.manipulateAsync(
        editingUri,
        [{ rotate: angle }],
        { compress: 0.9, format: ImageManipulator.SaveFormat.JPEG }
      );

      // Actualiza la lista de fotos con la URI de la imagen rotada (reemplazo por índice)
      setPhotos((prev) => {
        const idx = prev.indexOf(editingUri);
        if (idx >= 0) {
          const next = [...prev];
          next[idx] = uri;
          return next;
        }
        return [...prev, uri];
      });

      // El editor necesita la nueva URI
      setEditingUri(uri);

      // Mantener el filtro asignado a esta foto al cambiar su URI
      setPhotoFilters((prev) => {
        const current = prev[editingUri];
        if (current) {
          const { [editingUri]: _omit, ...rest } = prev;
          return { ...rest, [uri]: current };
        }
        return prev;
      });

      // Mantener bandera de recorte al rotar (si ya estaba recortada)
      setCroppedUris((prev) => {
        const was = !!prev[editingUri];
        const { [editingUri]: _omit, ...rest } = prev;
        return was ? { ...rest, [uri]: true } : rest;
      });

      // Reinicia el área de recorte para reflejar la nueva orientación
      setCropRect(null);
      setImageSize(null);
      // Recalcular tamaño de imagen para disparar el re-layout del polígono
      Image.getSize(uri, (w, h) => setImageSize({ width: w, height: h }), () => {});

    } catch (e) {
      // Fallback: intenta con compresión menor y, si falla, redimensiona antes de rotar
      try {
        const resized = await ImageManipulator.manipulateAsync(
          editingUri,
          [{ resize: { width: 1920 } }],
          { compress: 0.8, format: ImageManipulator.SaveFormat.JPEG }
        );
        const rotated = await ImageManipulator.manipulateAsync(
          resized.uri,
          [{ rotate: angle }],
          { compress: 0.85, format: ImageManipulator.SaveFormat.JPEG }
        );
        setPhotos((prev) => {
          const idx = prev.indexOf(editingUri);
          if (idx >= 0) {
            const next = [...prev];
            next[idx] = rotated.uri;
            return next;
          }
          return [...prev, rotated.uri];
        });
        setEditingUri(rotated.uri);

        // Mantener el filtro asignado al cambiar la URI tras fallback
        setPhotoFilters((prev) => {
          const current = prev[editingUri];
          if (current) {
            const { [editingUri]: _omit, ...rest } = prev;
            return { ...rest, [rotated.uri]: current };
          }
          return prev;
        });
        // Mantener bandera de recorte al rotar con fallback (si ya estaba recortada)
        setCroppedUris((prev) => {
          const was = !!prev[editingUri];
          const { [editingUri]: _omit, ...rest } = prev;
          return was ? { ...rest, [rotated.uri]: true } : rest;
        });
        setCropRect(null);
        setImageSize(null);
        Image.getSize(rotated.uri, (w, h) => setImageSize({ width: w, height: h }), () => {});
      } catch (err) {
        setLiveRotation(0);
        Alert.alert('Error', 'No se pudo rotar la imagen.');
      }
    }
  };

  // Guardar cambios combinados: recorte primero, luego rotación/volteo
  const saveEdits = async () => {
    if (!editingUri) return;
    const angle = Math.round(liveRotation);
    const actions: any[] = [];
    // Guardar referencia del último recorte calculado para persistir en photoCrops
    let lastSafeCrop: { originX: number; originY: number; width: number; height: number } | null = null;
    try {
      // Añadir recorte si existe (usar dimensiones originales del layout 'contain')
      if (cropRect && imageSize && displayRect) {
        const scaleX = imageSize.width / displayRect.width;
        const scaleY = imageSize.height / displayRect.height;
        const originX = Math.round((cropRect.x - displayRect.x) * scaleX);
        const originY = Math.round((cropRect.y - displayRect.y) * scaleY);
        const width = Math.round(cropRect.width * scaleX);
        const height = Math.round(cropRect.height * scaleY);
        const safeCrop = boundCrop(imageSize.width, imageSize.height, originX, originY, width, height);
        lastSafeCrop = safeCrop;
        actions.push({ crop: safeCrop });
      }
      // Añadir volteo si está activado
      if (pendingFlip) {
        actions.push({ flip: ImageManipulator.FlipType.Horizontal });
      }
      // Añadir rotación si corresponde
      if (angle !== 0) {
        actions.push({ rotate: angle });
      }

      // Si no hay cambios, solo cerrar el editor
      if (actions.length === 0 && angle === 0 && !pendingFlip) {
        setEditingUri(null);
        return;
      }

      const { uri } = await ImageManipulator.manipulateAsync(
        editingUri,
        actions,
        { compress: 0.9, format: ImageManipulator.SaveFormat.JPEG }
      );
      // Actualizar fotos y mantener una referencia local del arreglo actualizado
      const idx = photos.indexOf(editingUri);
      const updatedPhotos = idx >= 0 ? (() => { const next = [...photos]; next[idx] = uri; return next; })() : [...photos, uri];
      setPhotos(updatedPhotos);

      // Conservar filtro asignado al actualizar la URI tras guardar
      setPhotoFilters((prev) => {
        const current = prev[editingUri];
        if (current) {
          const { [editingUri]: _omit, ...rest } = prev;
          return { ...rest, [uri]: current };
        }
        return prev;
      });

      // Si hubo recorte, marcar nueva URI como recortada por la app
      const didCrop = !!(cropRect && imageSize && displayRect);
      if (didCrop) {
        setCroppedUris((prev) => {
          const { [editingUri]: _omit, ...rest } = prev;
          return { ...rest, [uri]: true };
        });
        // Persistir el recorte en píxeles originales para reabrir correctamente
        if (lastSafeCrop) {
          setPhotoCrops((prev) => {
            const { [editingUri]: _omit, ...rest } = prev;
            return { ...rest, [uri]: lastSafeCrop! };
          });
        }
      }

      // Reset y cerrar editor
      setEditingUri(null);
      setLiveRotation(0);
      setPendingFlip(false);
      setCropRect(null);
      setImageSize(null);
      if (returnToCameraOnSave) {
        setMode('camera');
        setReturnToCameraOnSave(false);
      }
      // Si está activo el modo DNI y ya hay dos fotos nuevas desde que empezó la sesión, generar el PDF automáticamente
      if (dniMode && dniSessionStartIndex !== null) {
        const basePhotos = updatedPhotos ?? photos;
        const count = basePhotos.length - dniSessionStartIndex;
        if (count >= 2) {
          setDniMode(false);
          showToast('Generando PDF DNI…');
          try {
            await createDniPdf(basePhotos.slice(dniSessionStartIndex, dniSessionStartIndex + 2));
          } finally {
            setDniSessionStartIndex(null);
          }
        } else {
          showToast(`Fotos DNI: ${count}/2`);
        }
      }
    } catch (e) {
      // Fallback: recortar primero, luego rotar/voltear y opcionalmente redimensionar
      try {
        let baseUri = editingUri;
        if (cropRect && imageSize && displayRect) {
          const scaleX = imageSize.width / displayRect.width;
          const scaleY = imageSize.height / displayRect.height;
          const originX = Math.round((cropRect.x - displayRect.x) * scaleX);
          const originY = Math.round((cropRect.y - displayRect.y) * scaleY);
          const width = Math.round(cropRect.width * scaleX);
          const height = Math.round(cropRect.height * scaleY);
          const safeCrop = boundCrop(imageSize.width, imageSize.height, originX, originY, width, height);
          const cropped = await ImageManipulator.manipulateAsync(
            editingUri,
            [{ crop: safeCrop }],
            { compress: 0.9, format: ImageManipulator.SaveFormat.JPEG }
          );
          baseUri = cropped.uri;
          // Persistir el recorte en photoCrops también en fallback
          setPhotoCrops((prev) => {
            const { [editingUri]: _omit, ...rest } = prev;
            return { ...rest, [cropped.uri]: safeCrop };
          });
          setCroppedUris((prev) => {
            const { [editingUri]: _omit, ...rest } = prev;
            return { ...rest, [cropped.uri]: true };
          });
        }
        const fallbackActions: any[] = [{ resize: { width: 1920 } }];
        if (pendingFlip) fallbackActions.push({ flip: ImageManipulator.FlipType.Horizontal });
        if (angle !== 0) fallbackActions.push({ rotate: angle });
        const manipulated = await ImageManipulator.manipulateAsync(
          baseUri,
          fallbackActions,
          { compress: 0.85, format: ImageManipulator.SaveFormat.JPEG }
        );
        const fIdx = photos.indexOf(editingUri);
        const updatedPhotosFb = fIdx >= 0 ? (() => { const next = [...photos]; next[fIdx] = manipulated.uri; return next; })() : [...photos, manipulated.uri];
        setPhotos(updatedPhotosFb);

        // Conservar filtro asignado al actualizar la URI tras fallback
        setPhotoFilters((prev) => {
          const current = prev[editingUri];
          if (current) {
            const { [editingUri]: _omit, ...rest } = prev;
            return { ...rest, [manipulated.uri]: current };
          }
          return prev;
        });

        // Si hubo recorte en el paso previo, marcar la URI manipulada como recortada
        if (cropRect && imageSize && displayRect) {
          setCroppedUris((prev) => {
            const { [editingUri]: _omit, ...rest } = prev;
            return { ...rest, [manipulated.uri]: true };
          });
          // Ya guardamos el recorte sobre la URI intermedia (cropped.uri),
          // y la última URI manipulada debe considerarse recortada; el rectángulo
          // sigue siendo válido respecto a la imagen recortada.
          setPhotoCrops((prev) => {
            const next = { ...prev };
            // Si existía en baseUri, mover a la final
            if (next[baseUri]) {
              next[manipulated.uri] = next[baseUri];
              delete next[baseUri];
              return next;
            }
            // En caso contrario, mantener entrada previa del editingUri si existiera
            const { [editingUri]: _omit, ...rest } = prev;
            return rest;
          });
        }

        setEditingUri(null);
        setLiveRotation(0);
        setPendingFlip(false);
        setCropRect(null);
        setImageSize(null);
        if (returnToCameraOnSave) {
          setMode('camera');
          setReturnToCameraOnSave(false);
        }
      } catch (err) {
        setLiveRotation(0);
        Alert.alert('Error', 'No se pudo guardar los cambios.');
      }
    }
  };

  const bumpRotation = (deg: number) => {
    setLiveRotation((prev) => {
      const nr = Math.max(-180, Math.min(180, Math.round(prev + deg)));
      return nr;
    });
    pushHistory();
  };

  const toggleFlip = () => {
    setPendingFlip((f) => !f);
    pushHistory();
  };

  // Auto-recorte: recalcular cropRect según displayRect, aspecto y ángulo actual
  const autoCrop = () => {
    if (!displayRect || !imageSize) return;
    // Igualar al marco de cámara: en DNI usar aspecto horizontal, 80% ancho y máx 72% alto
    const a4Portrait = 210 / 297;
    const letterPortrait = 8.5 / 11;
    const a4Landscape = 297 / 210;
    const letterLandscape = 11 / 8.5;
    const useLandscape = dniMode === true;
    const pageAspect = docPage === 'A4'
      ? (useLandscape ? a4Landscape : a4Portrait)
      : (useLandscape ? letterLandscape : letterPortrait);
    let w = displayRect.width * 0.8;
    let h = w / pageAspect;
    const maxH = displayRect.height * 0.72;
    if (h > maxH) {
      h = maxH;
      w = h * pageAspect;
    }
    const x = displayRect.x + (displayRect.width - w) / 2;
    const y = displayRect.y + (displayRect.height - h) / 2;
    setCropRect({ x, y, width: w, height: h });
    pushHistory();
  };

  const cycleAspectRatio = () => {
    setAspectIdx((i) => {
      const ni = (i + 1) % aspectRatios.length;
      const ratio = aspectRatios[ni].value;
      if (ratio && displayRect) {
        const dr = displayRect;
        let w = dr.width;
        let h = w / ratio;
        if (h > dr.height) {
          h = dr.height;
          w = h * ratio;
        }
        const nx = dr.x + (dr.width - w) / 2;
        const ny = dr.y + (dr.height - h) / 2;
        setCropRect({ x: nx, y: ny, width: w, height: h });
      }
      return ni;
    });
    pushHistory();
  };

  const cancelEdit = () => setEditingUri(null);
  const [rotationDeg, setRotationDeg] = useState<number>(0);

  const createPdf = async () => {
    if (photos.length === 0) {
      Alert.alert('Sin fotos', 'Agregá al menos una foto para previsualizar.');
      return;
    }
    setCreatingPdf(true);
    try {
      const pagesHtml: string[] = [];
      for (let idx = 0; idx < photos.length; idx++) {
        const uri = photos[idx];
        const f = photoFilters[uri] ?? 'none';
        const isDoc = (f === 'document' || f === 'grayscale');
        let targetWidth: number;
        let quality: number;
        if (pdfQuality === 'light') {
          targetWidth = isDoc ? 600 : 720;
          quality = isDoc ? 0.42 : 0.55;
        } else if (pdfQuality === 'medium') {
          targetWidth = isDoc ? 800 : 1000;
          quality = isDoc ? 0.6 : 0.7;
        } else {
          targetWidth = isDoc ? 1024 : 1280;
          quality = isDoc ? 0.78 : 0.85;
        }
        let manipulated: any;
        try {
          manipulated = await ImageManipulator.manipulateAsync(
            uri,
            [{ resize: { width: targetWidth } }],
            { compress: quality, format: ImageManipulator.SaveFormat.JPEG, base64: true }
          );
        } catch (e) {
          manipulated = { uri, width: 595, height: 842, base64: null };
        }
        let base64: string | null = null;
        try {
          base64 = manipulated.base64 ?? null;
        } catch {}
        if (!base64) {
          try {
            const readUri = manipulated.uri ?? uri;
            // @ts-ignore
            base64 = await FileSystem.readAsStringAsync(readUri, { encoding: 'base64' });
          } catch {}
        }
        if (!base64) {
          // Si falla esta foto, no bloquear toda la previsualización
          continue;
        }
        const pageW = 595;
        const pageH = 842;
        const filterId = `filter_${idx}`;
        let filterDef = '';
        switch (f) {
          case 'grayscale':
            filterDef = `<filter id="${filterId}" color-interpolation-filters="sRGB"><feColorMatrix type="saturate" values="0" /></filter>`;
            break;
          case 'contrast':
            filterDef = `<filter id="${filterId}" color-interpolation-filters="sRGB"><feComponentTransfer>
                 <feFuncR type="linear" slope="1.25" intercept="0" />
                 <feFuncG type="linear" slope="1.25" intercept="0" />
                 <feFuncB type="linear" slope="1.25" intercept="0" />
               </feComponentTransfer></filter>`;
            break;
          case 'antimoire':
            filterDef = `<filter id="${filterId}" color-interpolation-filters="sRGB">
              <feGaussianBlur in="SourceGraphic" stdDeviation="0.6" />
              <feComponentTransfer>
                <feFuncR type="linear" slope="1.04" />
                <feFuncG type="linear" slope="1.04" />
                <feFuncB type="linear" slope="1.04" />
              </feComponentTransfer>
            </filter>`;
            break;
          case 'enhance':
            filterDef = `<filter id="${filterId}" color-interpolation-filters="sRGB">
              <feGaussianBlur in="SourceGraphic" stdDeviation="1" result="blur" />
              <feComposite in="SourceGraphic" in2="blur" operator="arithmetic" k1="1" k2="0" k3="-0.6" k4="0" result="sharp" />
              <feComponentTransfer>
                <feFuncR type="linear" slope="1.10" />
                <feFuncG type="linear" slope="1.10" />
                <feFuncB type="linear" slope="1.10" />
              </feComponentTransfer>
            </filter>`;
            break;
          case 'document':
            filterDef = `<filter id="${filterId}" color-interpolation-filters="sRGB">
              <feColorMatrix type="saturate" values="0" result="gray" />
              <feComponentTransfer>
                <feFuncR type="gamma" amplitude="1" exponent="1.8" offset="0" />
                <feFuncG type="gamma" amplitude="1" exponent="1.8" offset="0" />
                <feFuncB type="gamma" amplitude="1" exponent="1.8" offset="0" />
              </feComponentTransfer>
            </filter>`;
            break;
          default:
            filterDef = '';
        }
        const imgNode = f === 'none'
          ? `<image x=\"0\" y=\"0\" width=\"${pageW}\" height=\"${pageH}\" preserveAspectRatio=\"xMidYMid slice\" xlink:href=\"data:image/jpeg;base64,${base64}\" href=\"data:image/jpeg;base64,${base64}\" />`
          : `<g filter=\"url(#${filterId})\"><image x=\"0\" y=\"0\" width=\"${pageW}\" height=\"${pageH}\" preserveAspectRatio=\"xMidYMid slice\" xlink:href=\"data:image/jpeg;base64,${base64}\" href=\"data:image/jpeg;base64,${base64}\" /></g>`;
        pagesHtml.push(`<div class=\"page\">
          <svg xmlns=\"http://www.w3.org/2000/svg\" xmlns:xlink=\"http://www.w3.org/1999/xlink\" width=\"100%\" height=\"100%\" viewBox=\"0 0 595 842\" preserveAspectRatio=\"xMidYMid meet\">
            <defs>${filterDef}</defs>
            <rect x=\"0\" y=\"0\" width=\"595\" height=\"842\" fill=\"white\" />
            ${imgNode}
          </svg>
        </div>`);
      }
      if (pagesHtml.length === 0) {
        Alert.alert('Error', 'No se pudieron preparar las imágenes para el PDF.');
        return;
      }

      const html = `<!DOCTYPE html><html><head><meta charset="utf-8"/>
       <style>
         @page { size: A4; margin: 0; }
         body { margin: 0; padding: 0; }
         .page {
           display: block;
           overflow: hidden;
           object-fit: cover;
           margin: 0;
           padding: 0;
           width: 595pt;
           height: 842pt;
           page-break-inside: avoid;
         }
         svg { display:block; width: 100%; height: 100%; }
         /* Evitar página en blanco al final: aplicar salto solo antes de páginas posteriores */
         .page { page-break-after: auto; }
         .page:not(:first-child) { page-break-before: always; }
       </style>
       </head><body>${pagesHtml.join('')}</body></html>`;
      // En vez de guardar/compartir directamente, abrimos previsualización
      // En Web, además abrimos una pestaña con la vista previa para mejorar UX
      if (isWeb) {
        try {
          const win = window.open('', '_blank');
          if (win) {
            win.document.open();
            win.document.write(html);
            win.document.close();
          }
        } catch {}
      }
      // Feedback y pequeño delay para asegurar render del modal en móviles
      showToast('Previsualización lista');
      setTimeout(() => setPdfPreviewHtml(html), 30);
    } catch (e) {
      Alert.alert('Error', 'No se pudo crear el PDF.');
    } finally {
      setCreatingPdf(false);
    }
  };

  // Conversión directa: crea y guarda el PDF sin abrir la previsualización
  const convertPdfDirect = async () => {
    if (photos.length === 0 || isWeb) return;
    setCreatingPdf(true);
    try {
      const pagesHtml = await Promise.all(
        photos.map(async (uri, idx) => {
          const f = photoFilters[uri] ?? 'none';
          const isDoc = (f === 'document' || f === 'grayscale');
          let targetWidth: number;
          let quality: number;
          if (pdfQuality === 'light') {
            targetWidth = isDoc ? 600 : 720;
            quality = isDoc ? 0.42 : 0.55;
          } else if (pdfQuality === 'medium') {
            targetWidth = isDoc ? 800 : 1000;
            quality = isDoc ? 0.6 : 0.7;
          } else {
            targetWidth = isDoc ? 1024 : 1280;
            quality = isDoc ? 0.78 : 0.85;
          }
          const manipulated = await ImageManipulator.manipulateAsync(
            uri,
            [{ resize: { width: targetWidth } }],
            { compress: quality, format: ImageManipulator.SaveFormat.JPEG, base64: true }
          );
          // Preferir base64 directo del manipulador; fallback a lectura de archivo
          // @ts-ignore
          const base64 = manipulated.base64 ?? await FileSystem.readAsStringAsync(manipulated.uri, { encoding: 'base64' });
          const pageW = 595;
          const pageH = 842;
          const filterId = `filter_${idx}`;
          let filterDef = '';
          switch (f) {
            case 'grayscale':
              filterDef = `<filter id="${filterId}" color-interpolation-filters="sRGB"><feColorMatrix type="saturate" values="0" /></filter>`;
              break;
            case 'contrast':
              filterDef = `<filter id="${filterId}" color-interpolation-filters="sRGB"><feComponentTransfer>
                   <feFuncR type="linear" slope="1.25" intercept="0" />
                   <feFuncG type="linear" slope="1.25" intercept="0" />
                   <feFuncB type="linear" slope="1.25" intercept="0" />
                 </feComponentTransfer></filter>`;
              break;
            case 'antimoire':
              filterDef = `<filter id="${filterId}" color-interpolation-filters="sRGB">
                <feGaussianBlur in="SourceGraphic" stdDeviation="0.6" />
                <feComponentTransfer>
                  <feFuncR type="linear" slope="1.04" />
                  <feFuncG type="linear" slope="1.04" />
                  <feFuncB type="linear" slope="1.04" />
                </feComponentTransfer>
              </filter>`;
              break;
            case 'enhance':
              filterDef = `<filter id="${filterId}" color-interpolation-filters="sRGB">
                <feGaussianBlur in="SourceGraphic" stdDeviation="1" result="blur" />
                <feComposite in="SourceGraphic" in2="blur" operator="arithmetic" k1="1.15" k2="-0.15" k3="0" k4="0" result="unsharp" />
                <feComponentTransfer>
                  <feFuncR type="linear" slope="1.08" />
                  <feFuncG type="linear" slope="1.08" />
                  <feFuncB type="linear" slope="1.08" />
                </feComponentTransfer>
              </filter>`;
              break;
            case 'document':
              filterDef = `<filter id="${filterId}" color-interpolation-filters="sRGB">
                <feGaussianBlur in="SourceGraphic" stdDeviation="0.3" />
                <feComponentTransfer>
                  <feFuncR type="linear" slope="1.1" />
                  <feFuncG type="linear" slope="1.1" />
                  <feFuncB type="linear" slope="1.1" />
                </feComponentTransfer>
              </filter>`;
              break;
            default:
              filterDef = '';
          }
          const imgNode = f === 'none'
            ? `<image x="0" y="0" width="${pageW}" height="${pageH}" preserveAspectRatio="xMidYMid slice" xlink:href="data:image/jpeg;base64,${base64}" href="data:image/jpeg;base64,${base64}" />`
            : `<g filter="url(#${filterId})"><image x="0" y="0" width="${pageW}" height="${pageH}" preserveAspectRatio="xMidYMid slice" xlink:href="data:image/jpeg;base64,${base64}" href="data:image/jpeg;base64,${base64}" /></g>`;
          return `<div class="page">
            <svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="100%" height="100%" viewBox="0 0 595 842" preserveAspectRatio="xMidYMid meet">
              <defs>${filterDef}</defs>
              <rect x="0" y="0" width="595" height="842" fill="white" />
              ${imgNode}
            </svg>
          </div>`;
        })
      );

      const html = `<!DOCTYPE html><html><head><meta charset="utf-8"/>
       <style>
         @page { size: A4; margin: 0; }
         body { margin: 0; padding: 0; }
         .page {
           display: block;
           overflow: hidden;
           object-fit: cover;
           margin: 0;
           padding: 0;
           width: 595pt;
           height: 842pt;
           page-break-inside: avoid;
         }
         svg { display:block; width: 100%; height: 100%; }
         /* Evitar página en blanco al final: aplicar salto solo antes de páginas posteriores */
         .page { page-break-after: auto; }
         .page:not(:first-child) { page-break-before: always; }
       </style>
       </head><body>${pagesHtml.join('')}</body></html>`;

      const { uri } = await Print.printToFileAsync({ html });
      const safeName = (pdfName || 'scanpdf').replace(/[^a-z0-9-_. ]/gi, '').trim() || 'scanpdf';
      const fileName = `${safeName}.pdf`;
      // @ts-ignore
      const dest = FileSystem.documentDirectory ? `${FileSystem.documentDirectory}${fileName}` : uri;
      // @ts-ignore
      if (FileSystem.documentDirectory) {
        await FileSystem.moveAsync({ from: uri, to: dest });
      }
      showToast(`Guardado en la app: ${fileName}`);
      await loadSavedPdfs();
    } catch (e) {
      Alert.alert('Error', 'No se pudo convertir y guardar el PDF.');
    } finally {
      setCreatingPdf(false);
    }
  };

  // Exportar modo DNI: usa solo las dos primeras fotos y las apila en una sola página A4
  const createDniPdf = async (urisOverride?: string[]) => {
    if (isWeb) return;
    const uris = urisOverride ?? photos.slice(0, 2);
    if (uris.length < 2) {
      Alert.alert('Modo DNI', 'Necesitas al menos 2 fotos (frente y dorso).');
      return;
    }
    setCreatingPdf(true);
    try {
      const processed = await Promise.all(
        uris.map(async (uri, idx) => {
          const f = photoFilters[uri] ?? 'none';
          const isDoc = (f === 'document' || f === 'grayscale');
          let targetWidth: number;
          let quality: number;
          if (pdfQuality === 'light') {
            targetWidth = isDoc ? 600 : 720;
            quality = isDoc ? 0.42 : 0.55;
          } else if (pdfQuality === 'medium') {
            targetWidth = isDoc ? 800 : 1000;
            quality = isDoc ? 0.6 : 0.7;
          } else {
            targetWidth = isDoc ? 1024 : 1280;
            quality = isDoc ? 0.78 : 0.85;
          }
          // Evitar upscale: usar el tamaño original como límite
          let origW = 0; let origH = 0;
          await new Promise<void>((resolve) => {
            Image.getSize(uri, (w, h) => { origW = w; origH = h; resolve(); }, () => resolve());
          });
          const effWidth = Math.min(targetWidth, origW || targetWidth);
          const manipulated = await ImageManipulator.manipulateAsync(
            uri,
            (effWidth && origW && effWidth < origW) ? [{ resize: { width: effWidth } }] : [],
            { compress: quality, format: ImageManipulator.SaveFormat.JPEG, base64: true }
          );
          // @ts-ignore
          const base64 = manipulated.base64 ?? await FileSystem.readAsStringAsync(manipulated.uri, { encoding: 'base64' });
          const filterId = `dni_filter_${idx}`;
          let filterDef = '';
          switch (f) {
            case 'grayscale':
              filterDef = `<filter id="${filterId}" color-interpolation-filters="sRGB"><feColorMatrix type="saturate" values="0" /></filter>`;
              break;
            case 'contrast':
              filterDef = `<filter id="${filterId}" color-interpolation-filters="sRGB"><feComponentTransfer>
                   <feFuncR type="linear" slope="1.25" intercept="0" />
                   <feFuncG type="linear" slope="1.25" intercept="0" />
                   <feFuncB type="linear" slope="1.25" intercept="0" />
                 </feComponentTransfer></filter>`;
              break;
            case 'antimoire':
              filterDef = `<filter id="${filterId}" color-interpolation-filters="sRGB">
                <feGaussianBlur in="SourceGraphic" stdDeviation="0.6" />
                <feComponentTransfer>
                  <feFuncR type="linear" slope="1.04" />
                  <feFuncG type="linear" slope="1.04" />
                  <feFuncB type="linear" slope="1.04" />
                </feComponentTransfer>
              </filter>`;
              break;
            case 'enhance':
              filterDef = `<filter id="${filterId}" color-interpolation-filters="sRGB">
                <feGaussianBlur in="SourceGraphic" stdDeviation="1" result="blur" />
                <feComposite in="SourceGraphic" in2="blur" operator="arithmetic" k1="1" k2="0" k3="-0.6" k4="0" result="sharp" />
                <feComponentTransfer>
                  <feFuncR type="linear" slope="1.10" />
                  <feFuncG type="linear" slope="1.10" />
                  <feFuncB type="linear" slope="1.10" />
                </feComponentTransfer>
              </filter>`;
              break;
            case 'document':
              filterDef = `<filter id="${filterId}" color-interpolation-filters="sRGB">
                <feColorMatrix type="saturate" values="0" result="gray" />
                <feComponentTransfer>
                  <feFuncR type="gamma" amplitude="1" exponent="1.8" offset="0" />
                  <feFuncG type="gamma" amplitude="1" exponent="1.8" offset="0" />
                  <feFuncB type="gamma" amplitude="1" exponent="1.8" offset="0" />
                </feComponentTransfer>
              </filter>`;
              break;
            default:
              filterDef = '';
          }
          const mW = (manipulated as any)?.width as number | undefined;
          const mH = (manipulated as any)?.height as number | undefined;
          const aspect = (mW && mH && mH !== 0)
            ? (mW / mH)
            : ((origW && origH && origH !== 0) ? (origW / origH) : null);
          return { base64, filterDef, filterId, f, aspect };
        })
      );

      const pageW = 595; // A4 width
      const pageH = 842; // A4 height
      // Márgenes/bordes y separación entre imágenes (en puntos)
      const marginX = 24;
      const marginY = 24;
      const gapBetween = 24; // Separación entre frente y dorso
      const contentW = pageW - (2 * marginX);
      const contentH = pageH - (2 * marginY);
      // Dimensiones por imagen usando su aspecto real de recorte cuando esté disponible.
      const maxBoxW = Math.floor(contentW * 0.5);
      const maxBoxH = Math.floor((contentH - gapBetween) / 2);
      const getBoxForAspect = (asp?: number | null) => {
        const a = asp && asp > 0 ? asp : 1.58; // fallback al ratio típico de tarjeta
        // Respetar límites de ancho y alto: primero intentamos limitar por ancho, si se pasa por alto limitamos por alto
        let w = maxBoxW;
        let h = Math.floor(w / a);
        if (h > maxBoxH) {
          h = maxBoxH;
          w = Math.floor(h * a);
        }
        return { w, h };
      };
      const topBox = getBoxForAspect(processed[0]?.aspect as any);
      const bottomBox = getBoxForAspect(processed[1]?.aspect as any);
      const boxXTop = marginX + Math.floor((contentW - topBox.w) / 2);
      const boxXBottom = marginX + Math.floor((contentW - bottomBox.w) / 2);
      // Centrar verticalmente el conjunto con alturas independientes
      const totalBoxesH = topBox.h + bottomBox.h + gapBetween;
      const topY = marginY + Math.floor((contentH - totalBoxesH) / 2);
      const bottomY = topY + topBox.h + gapBetween;
      const defs = processed.map(p => p.filterDef).join('');
      const topImg = processed[0];
      const bottomImg = processed[1];
      const topNode = topImg.f === 'none'
        ? `<rect x="${boxXTop}" y="${topY}" width="${topBox.w}" height="${topBox.h}" fill="none" stroke="#d1d5db" stroke-width="3" />
           <image x="${boxXTop}" y="${topY}" width="${topBox.w}" height="${topBox.h}" preserveAspectRatio="xMidYMid meet" xlink:href="data:image/jpeg;base64,${topImg.base64}" href="data:image/jpeg;base64,${topImg.base64}" />`
        : `<rect x="${boxXTop}" y="${topY}" width="${topBox.w}" height="${topBox.h}" fill="none" stroke="#d1d5db" stroke-width="3" />
           <g filter="url(#${topImg.filterId})"><image x="${boxXTop}" y="${topY}" width="${topBox.w}" height="${topBox.h}" preserveAspectRatio="xMidYMid meet" xlink:href="data:image/jpeg;base64,${topImg.base64}" href="data:image/jpeg;base64,${topImg.base64}" /></g>`;
      const bottomNode = bottomImg.f === 'none'
        ? `<rect x="${boxXBottom}" y="${bottomY}" width="${bottomBox.w}" height="${bottomBox.h}" fill="none" stroke="#d1d5db" stroke-width="3" />
           <image x="${boxXBottom}" y="${bottomY}" width="${bottomBox.w}" height="${bottomBox.h}" preserveAspectRatio="xMidYMid meet" xlink:href="data:image/jpeg;base64,${bottomImg.base64}" href="data:image/jpeg;base64,${bottomImg.base64}" />`
        : `<rect x="${boxXBottom}" y="${bottomY}" width="${bottomBox.w}" height="${bottomBox.h}" fill="none" stroke="#d1d5db" stroke-width="3" />
           <g filter="url(#${bottomImg.filterId})"><image x="${boxXBottom}" y="${bottomY}" width="${bottomBox.w}" height="${bottomBox.h}" preserveAspectRatio="xMidYMid meet" xlink:href="data:image/jpeg;base64,${bottomImg.base64}" href="data:image/jpeg;base64,${bottomImg.base64}" /></g>`;

      const pageHtml = `<div class="page">
            <svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="100%" height="100%" viewBox="0 0 595 842" preserveAspectRatio="xMidYMid meet">
              <defs>${defs}</defs>
              <rect x="0" y="0" width="595" height="842" fill="white" />
              ${topNode}
              ${bottomNode}
            </svg>
          </div>`;

      const html = `<!DOCTYPE html><html><head><meta charset="utf-8"/>
       <style>
         @page { size: A4; margin: 0; }
         body { margin: 0; padding: 0; }
         .page img {
           display: block;
           overflow: hidden;
           object-fit:cover;
           margin: 0;
           padding: 0;
           width: 595pt;
           height: 842pt;
           page-break-inside: avoid;
         }
         svg { display:block; width: 100%; height: 100%; }
         .page { page-break-after: auto; }
         .page:not(:first-child) { page-break-before: always; }
       </style>
       </head><body>${pageHtml}</body></html>`;
      setPdfPreviewHtml(html);
    } catch (e) {
      Alert.alert('Error', 'No se pudo crear el PDF DNI.');
    } finally {
      setCreatingPdf(false);
    }
  };

  const savePdfFromPreview = async () => {
    if (!pdfPreviewHtml || isWeb) return;
    setSavingPdf(true);
    try {
      const { uri } = await Print.printToFileAsync({ html: pdfPreviewHtml });
      const safeName = (pdfName || 'scanpdf').replace(/[^a-z0-9-_. ]/gi, '').trim() || 'scanpdf';
      const fileName = `${safeName}.pdf`;
      // @ts-ignore
      const dest = FileSystem.documentDirectory ? `${FileSystem.documentDirectory}${fileName}` : uri;
      // @ts-ignore
      if (FileSystem.documentDirectory) {
        await FileSystem.moveAsync({ from: uri, to: dest });
      }
      showToast(`Guardado en la app: ${fileName}`);
      await loadSavedPdfs();
    } catch (e) {
      Alert.alert('Error', 'No se pudo guardar el PDF.');
    } finally {
      setSavingPdf(false);
    }
  };

  const sharePdfFromPreview = async () => {
    if (!pdfPreviewHtml || isWeb) return;
    try {
      const { uri } = await Print.printToFileAsync({ html: pdfPreviewHtml });
      const safeName = (pdfName || 'scanpdf').replace(/[^a-z0-9-_. ]/gi, '').trim() || 'scanpdf';
      const fileName = `${safeName}.pdf`;
      // @ts-ignore
      const dest = FileSystem.documentDirectory ? `${FileSystem.documentDirectory}${fileName}` : uri;
      // @ts-ignore
      if (FileSystem.documentDirectory) {
        await FileSystem.moveAsync({ from: uri, to: dest });
      }
      const canShare = !isWeb && (await Sharing.isAvailableAsync());
      if (canShare) {
        await Sharing.shareAsync(dest, { UTI: 'com.adobe.pdf', mimeType: 'application/pdf' });
      } else {
        Alert.alert('PDF creado', `Archivo guardado en: ${dest}`);
      }
      await loadSavedPdfs();
    } catch (e) {
      Alert.alert('Error', 'No se pudo compartir el PDF.');
    }
  };

  // Utilidades para la sección "Mis PDFs"
  const formatBytes = (bytes?: number) => {
    if (typeof bytes !== 'number') return '—';
    if (bytes < 1024) return `${bytes} B`;
    const kb = bytes / 1024;
    if (kb < 1024) return `${kb.toFixed(1)} KB`;
    const mb = kb / 1024;
    return `${mb.toFixed(2)} MB`;
  };
  const formatDate = (ts?: number) => {
    const t = normalizeMtime(ts);
    if (!t) return '—';
    try { return new Date(t).toLocaleDateString(); } catch { return '—'; }
  };
  const openSavedPdf = async (uri: string) => {
    try {
      // Limpiar la sesión actual para evitar mezclar fotos del último documento
      startNewDocumentSession();
      const entry = savedPdfs.find((p) => p.uri === uri);
      const name = entry?.name || 'scanpdf.pdf';
      const baseName = name.replace(/\.pdf$/i, '') || 'scanpdf';
      setPdfName(baseName);
      setMode('preview');
    } catch (e) {
      Alert.alert('Error', 'No se pudo abrir el PDF.');
    }
  };
  const shareSavedPdf = async (uri: string) => {
    try {
      const canShare = !isWeb && (await Sharing.isAvailableAsync());
      if (canShare) {
        await Sharing.shareAsync(uri, { UTI: 'com.adobe.pdf', mimeType: 'application/pdf' });
      } else {
        Alert.alert('PDF', `Archivo: ${uri}`);
      }
    } catch (e) {
      Alert.alert('Error', 'No se pudo compartir el PDF.');
    }
  };
  const deleteSavedPdf = async (uri: string) => {
    try {
      await FileSystem.deleteAsync(uri, { idempotent: true } as any);
      showToast('PDF eliminado');
      await loadSavedPdfs();
    } catch (e) {
      Alert.alert('Error', 'No se pudo eliminar el PDF.');
    }
  };

  // Búsqueda y listado completo de PDFs
  const [pdfSearchQuery, setPdfSearchQuery] = useState('');
  const [showAllPdfs, setShowAllPdfs] = useState(false);
  const filteredPdfs = savedPdfs.filter((p) => {
    const q = pdfSearchQuery.trim().toLowerCase();
    if (!q) return true;
    return p.name.toLowerCase().includes(q);
  });

  // Conversión a DOCX
  const [showConvertModal, setShowConvertModal] = useState(false);
  // OCR
  const [ocrMode, setOcrMode] = useState<boolean>(false);
  const [ocrLoading, setOcrLoading] = useState<boolean>(false);
  const [showOcrResult, setShowOcrResult] = useState<boolean>(false);
  const [ocrDownloadUrl, setOcrDownloadUrl] = useState<string | null>(null);
  const [ocrLocalPath, setOcrLocalPath] = useState<string | null>(null);
  const [ocrText, setOcrText] = useState<string | null>(null);
  const [ocrLanguage, setOcrLanguage] = useState<'spa' | 'eng'>('spa');
  // Edición de PDFs guardados
  const [editingSaved, setEditingSaved] = useState<{ name: string; uri: string } | null>(null);
  const [showEditSavedModal, setShowEditSavedModal] = useState(false);

  return (
    <SafeAreaProvider>
    <SafeAreaView style={styles.safe}>
      <StatusBar style="dark" />
      {mode === 'home' && (
        <>
          <LinearGradient colors={["#f8fafc", "#eef2f7"]} style={styles.header}>
            <Text style={styles.title}>ScanPdf</Text>
            <Text style={styles.subtitle}>Un proyecto de codigo libre </Text>
              <Text style={styles.subtitle}>by The Kirv Studio.</Text>
          </LinearGradient>
          <View style={styles.content}>
            <ScrollView contentContainerStyle={{ gap: 20 }}>
              {/* Grid 2x2 de funciones */}
              <View style={styles.featureGrid}>
                <TouchableOpacity onPress={beginScan} style={[styles.featureCard, { backgroundColor: '#D6E8FF' }]} accessibilityLabel="Escanear PDF">
                  <Ionicons name="scan-outline" size={32} color="#1f5c99" />
                  <Text style={styles.featureLabel}>Escanear PDF</Text>
                </TouchableOpacity>
                <TouchableOpacity onPress={beginDniMode} style={[styles.featureCard, { backgroundColor: '#DDF7F0' }]} accessibilityLabel="Modo DNI">
                  <Ionicons name="card-outline" size={32} color="#1e6f5c" />
                  <Text style={styles.featureLabel}>Modo DNI</Text>
                </TouchableOpacity>
                <TouchableOpacity onPress={() => { startNewDocumentSession(); setShowConvertModal(true); }} style={[styles.featureCard, { backgroundColor: '#FFE7D6' }]} accessibilityLabel="Convertir Formato">
                  <Ionicons name="swap-horizontal-outline" size={32} color="#9a4f26" />
                  <Text style={styles.featureLabel}>Convertir Formato</Text>
                </TouchableOpacity>
                <TouchableOpacity onPress={beginOcr} style={[styles.featureCard, { backgroundColor: '#E9E2F8' }]} accessibilityLabel="OCR (Extraer Texto)">
                  <Ionicons name="reader-outline" size={32} color="#5a4f86" />
                  <Text style={styles.featureLabel}>OCR (Extraer Texto)</Text>
                </TouchableOpacity>
              </View>


            {/* Sección: Mis PDFs */}
            <View style={[
              styles.card,
              {
                backgroundColor: 'transparent',
                // Quitar cualquier borde/sombra para evitar gris alrededor
                elevation: 0,
                shadowOpacity: 0,
                shadowRadius: 0,
                shadowColor: 'transparent',
                shadowOffset: { width: 0, height: 0 },
                borderWidth: 0,
              },
            ] }>
              <View style={styles.cardIconRow}>
                <Ionicons name="folder-open-outline" size={32} color={colors.primary} />
              </View>
              <Text style={styles.cardTitle}>Documentos recientes</Text>
              <Text style={styles.cardDesc}>Tus archivos creados y guardados.</Text>
              {/* Buscador y Ver todos */}
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10, marginTop: 8 }}>
                <TextInput
                  value={pdfSearchQuery}
                  onChangeText={setPdfSearchQuery}
                  placeholder="Buscar…"
                  placeholderTextColor={colors.secondaryText}
                  style={{ flex: 1, backgroundColor: '#f3f4f6', paddingVertical: 8, paddingHorizontal: 12, borderRadius: 12, color: colors.text }}
                />
                {filteredPdfs.length > 6 && (
                  <TouchableOpacity onPress={() => setShowAllPdfs(true)} style={[styles.editorGhostTextBtn, { borderWidth: 1, borderColor: '#d1d5db' }]} accessibilityLabel="Ver todos los PDFs">
                    <Text style={{ color: colors.text, fontWeight: '600' }}>Ver todos</Text>
                  </TouchableOpacity>
                )}
              </View>
              <View style={{ marginTop: 8, gap: 12 }}>
                {filteredPdfs.length === 0 ? (
                  <Text style={styles.cardDesc}>No hay PDFs guardados todavía.</Text>
                ) : (
                  filteredPdfs.slice(0, 6).map(({ name, uri, size, mtime }) => (
                    <TouchableOpacity key={uri} onPress={() => openSavedPdf(uri)} activeOpacity={0.8} accessibilityLabel={`Abrir ${name}`}>
                      <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
                        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12, flex: 1 }}>
                          <Ionicons name="document-text-outline" size={22} color={colors.primary} />
                          <View style={{ flex: 1 }}>
                            <Text style={{ color: colors.text, fontWeight: '600' }} numberOfLines={1}>{name}</Text>
                            <Text style={{ color: colors.secondaryText, fontSize: 12 }}>
                              {formatBytes(size)} • {formatDate(mtime)}
                            </Text>
                          </View>
                        </View>
                        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
                          <TouchableOpacity onPress={() => { setPdfName(name.replace(/\.pdf$/i, '')); setMode('preview'); }} accessibilityLabel={`Editar ${name}`}>
                            <Ionicons name="create-outline" size={18} color={colors.text} />
                          </TouchableOpacity>
                          {!isWeb && (
                            <TouchableOpacity onPress={() => shareSavedPdf(uri)} accessibilityLabel={`Compartir ${name}`}>
                              <Ionicons name="share-outline" size={18} color={colors.text} />
                            </TouchableOpacity>
                          )}
                          <TouchableOpacity onPress={() => Alert.alert('Eliminar PDF', `¿Quieres eliminar \"${name}\"?`, [
                            { text: 'Cancelar', style: 'cancel' },
                            { text: 'Eliminar', style: 'destructive', onPress: () => deleteSavedPdf(uri) },
                          ])} accessibilityLabel={`Eliminar ${name}`}>
                            <Ionicons name="trash-outline" size={18} color={colors.text} />
                          </TouchableOpacity>
                        </View>
                      </View>
                    </TouchableOpacity>
                  ))
                )}
              </View>
            </View>

            </ScrollView>

            {/* Modal: Lista completa de PDFs con búsqueda */}
            <Modal visible={showAllPdfs} animationType="slide" onRequestClose={() => setShowAllPdfs(false)}>
              <SafeAreaView style={{ flex: 1, backgroundColor: '#fff' }}>
                <View style={{ paddingHorizontal: 12, paddingVertical: 8, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
                  <Text style={{ color: colors.text, fontWeight: '700', fontSize: 16 }}>Mis PDFs</Text>
                  <TouchableOpacity onPress={() => setShowAllPdfs(false)} accessibilityLabel="Cerrar" style={{ padding: 8 }}>
                    <Ionicons name="close" size={20} color={colors.text} />
                  </TouchableOpacity>
                </View>
                <View style={{ paddingHorizontal: 12, paddingBottom: 8 }}>
                  <TextInput
                    value={pdfSearchQuery}
                    onChangeText={setPdfSearchQuery}
                    placeholder="Buscar…"
                    placeholderTextColor={colors.secondaryText}
                    style={{ backgroundColor: '#f3f4f6', paddingVertical: 10, paddingHorizontal: 14, borderRadius: 16, color: colors.text }}
                  />
                </View>
                <ScrollView contentContainerStyle={{ padding: 12, gap: 12 }}>
                  {filteredPdfs.length === 0 ? (
                    <Text style={styles.cardDesc}>No hay resultados.</Text>
                  ) : (
                    filteredPdfs.map(({ name, uri, size, mtime }) => (
                      <View key={uri} style={[styles.card, { padding: 12 }]}> 
                        <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
                          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12, flex: 1 }}>
                            <Ionicons name="document-text-outline" size={22} color={colors.primary} />
                            <View style={{ flex: 1 }}>
                              <Text style={{ color: colors.text, fontWeight: '600' }} numberOfLines={1}>{name}</Text>
                              <Text style={{ color: colors.secondaryText, fontSize: 12 }}>
                                {formatBytes(size)} • {formatDate(mtime)}
                              </Text>
                            </View>
                          </View>
                          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
                            <TouchableOpacity onPress={() => openSavedPdf(uri)} accessibilityLabel={`Abrir ${name}`}>
                              <Ionicons name="open-outline" size={18} color={colors.text} />
                            </TouchableOpacity>
                            <TouchableOpacity onPress={() => { startNewDocumentSession(); setPdfName(name.replace(/\.pdf$/i, '')); setMode('preview'); }} accessibilityLabel={`Editar ${name}`}>
                              <Ionicons name="create-outline" size={18} color={colors.text} />
                            </TouchableOpacity>
                            {!isWeb && (
                              <TouchableOpacity onPress={() => shareSavedPdf(uri)} accessibilityLabel={`Compartir ${name}`}>
                                <Ionicons name="share-outline" size={18} color={colors.text} />
                              </TouchableOpacity>
                            )}
                            <TouchableOpacity onPress={() => Alert.alert('Eliminar PDF', `¿Quieres eliminar \"${name}\"?`, [
                              { text: 'Cancelar', style: 'cancel' },
                              { text: 'Eliminar', style: 'destructive', onPress: () => deleteSavedPdf(uri) },
                            ])} accessibilityLabel={`Eliminar ${name}`}>
                              <Ionicons name="trash-outline" size={18} color={colors.text} />
                            </TouchableOpacity>
                          </View>
                        </View>
                      </View>
                    ))
                  )}
                </ScrollView>
              </SafeAreaView>
            </Modal>

            {photos.length > 0 && (
              <View style={styles.thumbRow}>
                {photos.slice(0, 4).map((uri) => (
                  <TouchableOpacity key={uri} onPress={() => openEditor(uri)}>
                    <View style={[styles.thumb, { overflow: 'hidden', position: 'relative' }]}> 
                      {isWeb ? (
                        <Image
                          source={{ uri }}
                          style={[StyleSheet.absoluteFillObject, ({ filter: getCssFilter(photoFilters[uri] ?? 'none') } as any)]}
                          resizeMode="cover"
                        />
                      ) : (
                        <FilteredPreview uri={uri} filter={(photoFilters[uri] ?? 'none') as any} height={56} fit="cover" />
                      )}
                      {!!(photoFilters[uri] && photoFilters[uri] !== 'none') && (
                        <View style={styles.filterBadgeSmall}>
                          <Text style={styles.filterBadgeTextSmall}>
                            {photoFilters[uri] === 'grayscale'
                              ? 'B/N'
                              : photoFilters[uri] === 'contrast'
                                ? 'Ctr'
                                : photoFilters[uri] === 'antimoire'
                                  ? 'AM'
                                  : photoFilters[uri] === 'document'
                                    ? 'Doc'
                                    : 'Mej'}
                          </Text>
                        </View>
                      )}
                    </View>
                  </TouchableOpacity>
                ))}
              </View>
            )}

            <View style={styles.footerNote}>
              <TouchableOpacity onPress={() => Linking.openURL('https://www.linkedin.com/in/gustavo-guillermo-alonso/')} accessibilityLabel="Abrir LinkedIn de Gustavo Guillermo Alonso">
                <Text style={styles.noteText}>By The Kirv Studio</Text>
              </TouchableOpacity>
            </View>
          </View>
        </>
      )}

      {mode === 'camera' && !isWeb && (
        <View style={styles.cameraContainer}>
<CameraView
  ref={(r) => { cameraRef.current = r; }}
  style={StyleSheet.absoluteFillObject}
  facing={facing}
  flash={flash}
/>
          {/* Guía de composición (Regla de tercios) */}
          {showGrid && (
            <View pointerEvents="none" style={[StyleSheet.absoluteFill, { justifyContent: 'center', alignItems: 'center' }]}> 
              {/* Grid 3x3 tipo editor */}
              <View style={{ position: 'absolute', left: '33.33%', top: 0, bottom: 0, width: 1, backgroundColor: 'rgba(255,255,255,0.25)' }} />
              <View style={{ position: 'absolute', left: '66.66%', top: 0, bottom: 0, width: 1, backgroundColor: 'rgba(255,255,255,0.25)' }} />
              <View style={{ position: 'absolute', top: '33.33%', left: 0, right: 0, height: 1, backgroundColor: 'rgba(255,255,255,0.25)' }} />
              <View style={{ position: 'absolute', top: '66.66%', left: 0, right: 0, height: 1, backgroundColor: 'rgba(255,255,255,0.25)' }} />
            </View>
          )}
          {/* Guía A4 para modo documento */}
          {docMode && (
            <View pointerEvents="none" style={[StyleSheet.absoluteFill, { justifyContent: 'center', alignItems: 'center' }]}> 
              {(() => {
                const win = Dimensions.get('window');
                const a4Portrait = 210 / 297; // retrato A4
                const letterPortrait = 8.5 / 11; // retrato Letter
                const a4Landscape = 297 / 210; // paisaje A4
                const letterLandscape = 11 / 8.5; // paisaje Letter
                // En modo DNI mostrar guía horizontal (paisaje)
                const pageAspect = docPage === 'A4'
                  ? (dniMode ? a4Landscape : a4Portrait)
                  : (dniMode ? letterLandscape : letterPortrait);
                let w = win.width * 0.8;
                let h = w / pageAspect;
                const maxH = win.height * 0.72;
                if (h > maxH) {
                  h = maxH;
                  w = h * pageAspect;
                }
                const x = (win.width - w) / 2;
                const y = (win.height - h) / 2;
                return (
                  <Svg style={StyleSheet.absoluteFill}>
                    <Rect x={x} y={y} width={w} height={h} stroke="rgba(255,255,255,0.85)" strokeWidth={2} fill="none" strokeDasharray="8 6" />
                    {/* Esquinas tipo L */}
                    {/* Superior izquierda */}
                    <Line x1={x} y1={y} x2={x + 24} y2={y} stroke="#fff" strokeWidth={3} />
                    <Line x1={x} y1={y} x2={x} y2={y + 24} stroke="#fff" strokeWidth={3} />
                    {/* Superior derecha */}
                    <Line x1={x + w} y1={y} x2={x + w - 24} y2={y} stroke="#fff" strokeWidth={3} />
                    <Line x1={x + w} y1={y} x2={x + w} y2={y + 24} stroke="#fff" strokeWidth={3} />
                    {/* Inferior izquierda */}
                    <Line x1={x} y1={y + h} x2={x + 24} y2={y + h} stroke="#fff" strokeWidth={3} />
                    <Line x1={x} y1={y + h} x2={x} y2={y + h - 24} stroke="#fff" strokeWidth={3} />
                    {/* Inferior derecha */}
                    <Line x1={x + w} y1={y + h} x2={x + w - 24} y2={y + h} stroke="#fff" strokeWidth={3} />
                    <Line x1={x + w} y1={y + h} x2={x + w} y2={y + h - 24} stroke="#fff" strokeWidth={3} />
                  </Svg>
                );
              })()}
              <View style={{ position: 'absolute', bottom: 90, backgroundColor: 'transparent', paddingVertical: 6, paddingHorizontal: 10, borderRadius: 999 }}>
                <Text style={{ color: '#fff', fontWeight: '600' }}>Documento: {docPage}</Text>
              </View>
              {dniMode && (
                <View style={{ position: 'absolute', bottom: 120, backgroundColor: 'transparent', paddingVertical: 6, paddingHorizontal: 10, borderRadius: 999 }}>
                  <Text style={{ color: '#fff', fontWeight: '600' }}>Sugerencia: usa el teléfono en vertical</Text>
                </View>
              )}
              {dniMode && (
                <View style={{ position: 'absolute', bottom: 60, left: 0, right: 0, alignItems: 'center' }}>
                  <View style={{ flexDirection: 'row', gap: 12, backgroundColor: 'rgba(0,0,0,0.35)', paddingVertical: 8, paddingHorizontal: 12, borderRadius: 999 }}>
                    <TouchableOpacity onPress={() => setDniFilter('none')} accessibilityLabel="Sin filtro"
                      style={{ paddingVertical: 6, paddingHorizontal: 10, borderRadius: 999, backgroundColor: dniFilter === 'none' ? '#0a84ff' : 'transparent', borderWidth: StyleSheet.hairlineWidth, borderColor: '#fff' }}>
                      <Text style={{ color: '#fff', fontWeight: '600' }}>Sin filtro</Text>
                    </TouchableOpacity>
                    <TouchableOpacity onPress={() => setDniFilter('grayscale')} accessibilityLabel="Blanco y negro"
                      style={{ paddingVertical: 6, paddingHorizontal: 10, borderRadius: 999, backgroundColor: dniFilter === 'grayscale' ? '#0a84ff' : 'transparent', borderWidth: StyleSheet.hairlineWidth, borderColor: '#fff' }}>
                      <Text style={{ color: '#fff', fontWeight: '600' }}>B/N</Text>
                    </TouchableOpacity>
                  </View>
                </View>
              )}
            </View>
          )}
          <View style={styles.cameraTopBar}>
            <BlurView intensity={30} tint="dark" style={styles.topBarBlur}>
              <TouchableOpacity onPress={() => { setMode('home'); setDniMode(false); setDniSessionStartIndex(null); }} style={styles.editorIconBtn} accessibilityLabel="Volver">
                <Ionicons name="close-outline" size={18} color="#fff" />
              </TouchableOpacity>
              {/* Título removido para despejar la vista de cámara */}
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
                <View style={[styles.counterPill, { backgroundColor: 'transparent', borderWidth: 1, borderColor: 'rgba(255,255,255,0.6)' }] }>
                  <Ionicons name="images-outline" size={16} color="#fff" />
                  <Text style={[styles.counterText, { color: '#fff' }]}>{photos.length}</Text>
                </View>
                <TouchableOpacity onPress={() => setFlash((f) => (f === 'off' ? 'on' : f === 'on' ? 'auto' : 'off'))} style={styles.editorIconBtn} accessibilityLabel="Flash">
                  <Ionicons name={flash === 'on' ? 'flash-outline' : flash === 'auto' ? 'flash-outline' : 'flash-off-outline'} size={18} color="#fff" />
                </TouchableOpacity>
                <TouchableOpacity onPress={() => setFacing((v) => (v === 'back' ? 'front' : 'back'))} style={styles.editorIconBtn} accessibilityLabel="Cambiar cámara">
                  <Ionicons name="camera-reverse-outline" size={18} color="#fff" />
                </TouchableOpacity>
                <TouchableOpacity onPress={() => { setDocMode((s) => { const ns = !s; showToast(ns ? 'Modo documento activo' : 'Modo documento desactivado'); return ns; }); }} style={styles.editorIconBtn} accessibilityLabel="Modo documento">
                  <Ionicons name="document-text-outline" size={18} color="#fff" />
                </TouchableOpacity>
                {docMode && (
                  <TouchableOpacity onPress={() => setDocPage((p) => (p === 'A4' ? 'Letter' : 'A4'))} style={styles.editorIconBtn} accessibilityLabel="Cambiar tamaño de hoja">
                    <Ionicons name="swap-vertical-outline" size={18} color="#fff" />
                  </TouchableOpacity>
                )}
                {docMode && (
                  <TouchableOpacity onPress={() => setDocReviewMode((m) => { const nm = !m; showToast(nm ? 'Revisión antes de guardar' : 'Guardado automático'); return nm; })} style={styles.editorIconBtn} accessibilityLabel="Alternar revisión/auto guardado">
                    <Ionicons name={docReviewMode ? 'time-outline' : 'checkmark-done-outline'} size={18} color="#fff" />
                  </TouchableOpacity>
                )}
              </View>
            </BlurView>
          </View>
          <View style={styles.cameraBottomBar}>
            <BlurView intensity={30} tint="light" style={styles.bottomBarBlur}>
              <TouchableOpacity onPress={takePhoto} style={styles.shutterBtn} activeOpacity={0.8}>
                <View style={styles.shutterInner} />
              </TouchableOpacity>
              {photos.length > 0 && (
                <TouchableOpacity onPress={() => openEditor(lastAddedUri ?? photos[photos.length - 1])} style={styles.actionBtn}>
                  <Text style={styles.actionBtnText}>Editar última</Text>
                </TouchableOpacity>
              )}
              <TouchableOpacity onPress={goToPreview} style={[styles.actionBtn, (photos.length === 0) && { opacity: 0.5 }]} disabled={photos.length === 0}>
                
                <Text style={styles.actionBtnText}>Previsualizar</Text>
              </TouchableOpacity>
            </BlurView>
          </View>
        </View>
      )}
      {mode === 'camera' && isWeb && (
        <View style={[styles.content, { alignItems: 'center', justifyContent: 'center' }]}> 
          <Text style={styles.cardDesc}>La cámara no está disponible en web. Prueba en tu móvil con Expo Go.</Text>
        </View>
      )}

      {mode === 'preview' && (
        <View style={[styles.content, { paddingTop: 0 }]}> 
          <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingVertical: 12, paddingHorizontal: 12 }}>
            <TouchableOpacity onPress={() => setMode('camera')} style={styles.editorGhostTextBtn}>
                      <Ionicons name="close-outline" size={26} color={colors.text} />
            </TouchableOpacity>
            <View style={{ flexDirection: 'row', alignItems: 'center', flex: 1, marginHorizontal: 12, gap: 10 }}>
              <TouchableOpacity onPress={() => { setReturnToPreviewAfterShot(true); setMode('camera'); }} style={styles.editorIconBtn} accessibilityLabel="Agregar fotos">
                <Ionicons name="camera-outline" size={18} color="#000" />
              </TouchableOpacity>
              <TextInput
                value={pdfName}
                onChangeText={setPdfName}
                placeholder="Nombre del PDF"
                placeholderTextColor={colors.secondaryText}
                style={{ backgroundColor: '#f3f4f6', paddingVertical: 10, paddingHorizontal: 24, borderRadius: 16, flex: 1, minWidth: 0, color: colors.text }}
              />
            </View>
            <View style={{ flexDirection: 'row', gap: 10, alignItems: 'center' }}>
              {/* Botón Previsualizar movido a la barra inferior */}
              
              {photos.length > 0 && (
                <TouchableOpacity onPress={() => { /* acción directa opcional deshabilitada */ }} style={[styles.editorGhostTextBtn, { opacity: 0.6 }]} disabled>
                  <Text style={{ color: '#fff', fontSize: 16, fontWeight: '600' }}>Crear directo</Text>
                </TouchableOpacity>
              )}
            </View>
          </View>
          {/* Barra inferior de acciones en previsualización */}
          <View style={{ position: 'absolute', bottom: 0, left: 0, right: 0, paddingBottom: 16, paddingHorizontal: 12, zIndex: 10, elevation: 8 }}>
            <BlurView intensity={30} tint="light" style={[styles.bottomBarBlur, { flexDirection: 'column', alignItems: 'stretch', gap: 10 }]}>
              <TouchableOpacity onPress={createPdf} style={[{ backgroundColor: colors.primary, paddingVertical: 12, borderRadius: 12, alignItems: 'center' }, (photos.length === 0 || creatingPdf) && { opacity: 0.6 }]} disabled={photos.length === 0 || creatingPdf}>
                <Text style={{ color: '#fff', fontWeight: '700' }}>{creatingPdf ? 'Preparando…' : 'Previsualizar PDF'}</Text>
              </TouchableOpacity>
              <TouchableOpacity onPress={convertPdfDirect} style={[{ backgroundColor: colors.primary, paddingVertical: 12, borderRadius: 12, alignItems: 'center' }, (photos.length === 0 || creatingPdf) && { opacity: 0.6 }]} disabled={photos.length === 0 || creatingPdf}>
                <Text style={{ color: '#fff', fontWeight: '700' }}>{creatingPdf ? 'Preparando…' : 'Guardar'}</Text>
              </TouchableOpacity>
            </BlurView>
          </View>
          {/* Selector de Filtros (aplica a todas las fotos) */}
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10, paddingHorizontal: 12, paddingBottom: 8 }}>
            <Text style={{ color: colors.text, fontWeight: '600' }}>Filtros:</Text>
            <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ alignItems: 'center', gap: 10 }}>
              {(['none','grayscale','contrast','antimoire','document'] as const).map((f) => {
                const label = f === 'none'
                  ? 'Ninguno'
                  : f === 'grayscale'
                    ? 'B/N'
                    : f === 'contrast'
                      ? 'Contraste'
                      : f === 'antimoire'
                        ? 'Anti-moiré'
                        : 'Documento';
                return (
                  <TouchableOpacity key={f} onPress={() => setFilterForAllPhotos(f)} style={[styles.editorGhostTextBtn, { borderWidth: 1, borderColor: '#d1d5db' }]}
                    accessibilityLabel={`Aplicar filtro ${label} a todas`}>
                    <Text style={{ color: colors.text }}>{label}</Text>
                  </TouchableOpacity>
                );
              })}
            </ScrollView>
          </View>
          {/* Selector de calidad PDF (movido debajo de filtros) */}
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10, paddingHorizontal: 12, paddingBottom: 8 }}>
            <Text style={{ color: colors.text, fontWeight: '600' }}>Calidad:</Text>
            {([['light','Ligero'],['medium','Medio'],['high','Alto']] as const).map(([q,label]) => {
              const active = pdfQuality === q;
              return (
                <TouchableOpacity
                  key={q}
                  onPress={() => setPdfQuality(q)}
                  style={[styles.editorGhostTextBtn, { borderWidth: 1, borderColor: active ? colors.primary : '#d1d5db', backgroundColor: active ? 'rgba(10,132,255,0.12)' : 'transparent' }]}
                  accessibilityLabel={`Calidad ${label}`}
                >
                  <Text style={{ color: active ? colors.primary : colors.text }}>{label}</Text>
                </TouchableOpacity>
              );
            })}
          </View>
          <ScrollView
            ref={(r) => { previewScrollRef.current = r; }}
            style={{ flex: 1 }}
            contentContainerStyle={{ gap: 12, flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'space-between' }}
            scrollEnabled={!draggingUri}
          >
            {photos.map((uri) => (
              <TouchableOpacity
                key={uri}
                onPress={() => openEditor(uri)}
                onLongPress={() => startDrag(uri)}
                onPressOut={() => draggingUri && finalizeDrag()}
                delayLongPress={350}
                activeOpacity={0.9}
                style={[
                  { width: '48%' },
                  draggingUri === uri && { transform: [{ translateY: dragDy }], zIndex: 10 },
                ]}
              >
                <View style={[styles.card, { padding: 0 }, lastAddedUri === uri && { borderWidth: 2, borderColor: colors.primary }]}> 
                  <View style={{ position: 'relative' }}>
                    {isWeb ? (
                      <View style={[{ width: '100%', height: 220 }, ({ filter: getCssFilter(photoFilters[uri] ?? 'none') } as any)]}>
                        <Image
                          source={{ uri }}
                          style={{ width: '100%', height: '100%' }}
                          resizeMode="contain"
                        />
                      </View>
                    ) : (
                      <FilteredPreview uri={uri} filter={photoFilters[uri] ?? 'none'} height={220} fit="contain" />
                    )}
                    {!!(photoFilters[uri] && photoFilters[uri] !== 'none') && (
                      <View style={styles.filterBadge}>
                        <Text style={styles.filterBadgeText}>
                          {photoFilters[uri] === 'grayscale'
                            ? 'B/N'
                            : photoFilters[uri] === 'contrast'
                              ? 'Contraste'
                              : photoFilters[uri] === 'antimoire'
                                ? 'Anti-moiré'
                                : photoFilters[uri] === 'document'
                                  ? 'Documento'
                                  : 'Mejora'}
                        </Text>
                      </View>
                    )}
                    <View style={styles.imageTopActions}>
                      <TouchableOpacity style={styles.overlayIconBtn} onPress={() => openEditor(uri)} accessibilityLabel="Editar">
                        <Ionicons name="cut-outline" size={18} color="blue" />
                      </TouchableOpacity>
                      <TouchableOpacity style={styles.overlayIconBtn} onPress={() => Alert.alert('Eliminar foto', '¿Quieres eliminar esta foto?', [
                        { text: 'Cancelar', style: 'cancel' },
                        { text: 'Eliminar', style: 'destructive', onPress: () => removePhoto(uri) },
                      ])} accessibilityLabel="Eliminar">
                        <Ionicons name="trash-outline" size={18} color="blue" />
                      </TouchableOpacity>
                      <TouchableOpacity
                        style={[styles.overlayIconBtn, draggingUri === uri && { borderColor: '#fff' }]}
                        onPressIn={() => startDrag(uri)}
                        onLongPress={() => startDrag(uri)}
                        onPressOut={() => draggingUri && finalizeDrag()}
                        delayLongPress={250}
                        accessibilityLabel="Arrastrar para reordenar"
                      >
                        <Ionicons name="reorder-three-outline" size={18} color="blue" />
                      </TouchableOpacity>
                    </View>
                  </View>
                </View>
              </TouchableOpacity>
            ))}
            {photos.length === 0 && (
              <View style={[styles.card]}> 
                <Text style={styles.cardDesc}>No hay fotos para previsualizar.</Text>
              </View>
            )}
          </ScrollView>
          {draggingUri && (
            <View style={[StyleSheet.absoluteFill, { backgroundColor: 'transparent' }]} {...panResponder.panHandlers} pointerEvents="box-only" />
          )}
        </View>
      )}

      <Modal visible={!!editingUri} animationType="slide" onRequestClose={cancelEdit}>
        <View style={{ flex: 1, backgroundColor: '#000' }}>
          {/* Barra superior de acciones (previsualización) */}
          <View style={{ position: 'absolute', top: 0, left: 0, right: 0, paddingTop: 8, paddingHorizontal: 12, zIndex: 10 }}>
            <BlurView intensity={30} tint="dark" style={styles.topBarBlur}>
              <TouchableOpacity onPress={cancelEdit} style={styles.editorIconBtn} accessibilityLabel="Cerrar">
                <Ionicons name="close-outline" size={18} color="#fff" />
              </TouchableOpacity>
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
                <TouchableOpacity onPress={handleUndo} disabled={!canUndo()} style={[styles.editorIconBtn, !canUndo() && { opacity: 0.5 }]} accessibilityLabel="Deshacer">
                  <Ionicons name="arrow-undo-outline" size={18} color="#fff" />
                </TouchableOpacity>
                <TouchableOpacity onPress={saveEdits} style={styles.editorIconBtn} accessibilityLabel="Guardar">
                  <Ionicons name="checkmark-outline" size={18} color="#fff" />
                </TouchableOpacity>
              </View>
            </BlurView>
          </View>
          {/* Zona de visualización con cuadrícula */}
          <View style={{ flex: 1 }} onLayout={onEditorLayout}>
            {editingUri && (
              <Image
                source={{ uri: editingUri }}
                style={[
                  styles.editorImage,
                  pageRect && { position: 'absolute', left: pageRect.x, top: pageRect.y, width: pageRect.width, height: pageRect.height },
                  // Vista previa en vivo de rotación y volteo (no afecta cálculo de displayRect)
                  { transform: [{ rotate: `${liveRotation}deg` }, { scaleX: pendingFlip ? -1 : 1 }] },
                  (isWeb && ({ filter: getCssFilter(photoFilters[editingUri] ?? 'none') } as any))
                ]}
                resizeMode="contain"
                onLoad={(e: any) => {
                  const src = e?.nativeEvent?.source;
                  if (src && typeof src.width === 'number' && typeof src.height === 'number') {
                    onImageLoad(src.width, src.height);
                  } else {
                    Image.getSize(editingUri!, (w, h) => onImageLoad(w, h), () => {});
                  }
                }}
              />
            )}
            {displayRect && (
              <Svg style={{ position: 'absolute', left: 0, top: 0, right: 0, bottom: 0 }} pointerEvents="none">
                {/* Líneas de cuadrícula (Regla de tercios) */}
                <Line x1={displayRect.x + displayRect.width / 3} y1={displayRect.y} x2={displayRect.x + displayRect.width / 3} y2={displayRect.y + displayRect.height} stroke="rgba(255,255,255,0.25)" strokeWidth={1} />
                <Line x1={displayRect.x + (displayRect.width * 2) / 3} y1={displayRect.y} x2={displayRect.x + (displayRect.width * 2) / 3} y2={displayRect.y + displayRect.height} stroke="rgba(255,255,255,0.25)" strokeWidth={1} />
                <Line x1={displayRect.x} y1={displayRect.y + displayRect.height / 3} x2={displayRect.x + displayRect.width} y2={displayRect.y + displayRect.height / 3} stroke="rgba(255,255,255,0.25)" strokeWidth={1} />
                <Line x1={displayRect.x} y1={displayRect.y + (displayRect.height * 2) / 3} x2={displayRect.x + displayRect.width} y2={displayRect.y + (displayRect.height * 2) / 3} stroke="rgba(255,255,255,0.25)" strokeWidth={1} />
              </Svg>
            )}
            {cropRect && (
              <>
                <Svg style={{ position: 'absolute', left: 0, top: 0, right: 0, bottom: 0 }} pointerEvents="none">
                  <Rect
                    x={cropRect.x}
                    y={cropRect.y}
                    width={cropRect.width}
                    height={cropRect.height}
                    fill="rgba(10,132,255,0.08)"
                    stroke="#0a84ff"
                    strokeWidth={2}
                  />
                </Svg>
                <View
                  {...rectResponder.panHandlers}
                  pointerEvents={'box-only'}
                  style={{ position: 'absolute', left: cropRect.x, top: cropRect.y, width: cropRect.width, height: cropRect.height, zIndex: 1 }}
                />
                <View {...tlResponder.panHandlers} style={[styles.handle, { left: cropRect.x - 18, top: cropRect.y - 18, zIndex: 5 }]} />
                <View {...trResponder.panHandlers} style={[styles.handle, { left: cropRect.x + cropRect.width - 18, top: cropRect.y - 18, zIndex: 5 }]} />
                <View {...brResponder.panHandlers} style={[styles.handle, { left: cropRect.x + cropRect.width - 18, top: cropRect.y + cropRect.height - 18, zIndex: 5 }]} />
                <View {...blResponder.panHandlers} style={[styles.handle, { left: cropRect.x - 18, top: cropRect.y + cropRect.height - 18, zIndex: 5 }]} />
              </>
            )}
          </View>

          {/* Panel de control inferior */}
          <View style={{ padding: 16, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: '#1f2937', backgroundColor: '#0b0b0b' }}>
            {/* Indicador minimalista de ángulo + barra */}
            <View style={{ alignItems: 'center' }}>
              <Text style={{ color: '#fff', fontSize: 18, fontWeight: '700' }}>{liveRotation >= 0 ? `+${liveRotation}°` : `${liveRotation}°`}</Text>
              <View style={{ width: 340, height: 12, marginTop: 4 }}>
                <View style={{ position: 'absolute', left: 170, top: 0, bottom: 0, width: 1, backgroundColor: 'rgba(255,255,255,0.35)' }} />
              </View>
              <Slider
                style={{ width: 340, height: 24 }}
                minimumValue={-180}
                maximumValue={180}
                step={1}
                value={liveRotation}
                minimumTrackTintColor={colors.primary}
                maximumTrackTintColor="#374151"
                thumbTintColor={colors.primary}
                onValueChange={(v: number) => setLiveRotation(Math.round(v))}
                onSlidingComplete={(v: number) => { setLiveRotation(Math.round(v)); pushHistory(); }}
              />
              <Svg width={340} height={14} style={{ marginTop: 4 }}>
                {Array.from({ length: 25 }, (_, i) => {
                  const x = (i / 24) * 340;
                  const isMajor = i % 4 === 0; // marcas principales aprox cada 30-45°
                  return (
                    <Line key={`tick-${i}`} x1={x} y1={0} x2={x} y2={isMajor ? 12 : 6} stroke="rgba(255,255,255,0.35)" strokeWidth={1} />
                  );
                })}
              </Svg>
            </View>

            {/* Botones de acción rápida (iconos minimalistas) */}
            <View style={{ flexDirection: 'row', justifyContent: 'center', gap: 12, marginTop: 12 }}>
              <TouchableOpacity onPress={() => bumpRotation(-90)} style={styles.editorIconBtn} accessibilityLabel="Rotar -90 grados">
                <Ionicons name="refresh-outline" size={18} color="#fff" />
              </TouchableOpacity>
              <TouchableOpacity onPress={() => bumpRotation(90)} style={styles.editorIconBtn} accessibilityLabel="Rotar +90 grados">
                <Ionicons name="refresh-outline" size={18} color="#fff" />
              </TouchableOpacity>
              <TouchableOpacity onPress={toggleFlip} style={[styles.editorIconBtn, pendingFlip && { borderColor: '#10b981', backgroundColor: 'rgba(16,185,129,0.15)' }]} accessibilityLabel="Volteo horizontal">
                <Ionicons name="swap-horizontal-outline" size={18} color="#fff" />
              </TouchableOpacity>
              <TouchableOpacity onPress={cycleAspectRatio} style={styles.editorIconBtn} accessibilityLabel="Cambiar relación de aspecto">
                <Ionicons name="crop-outline" size={18} color="#fff" />
              </TouchableOpacity>
              <TouchableOpacity onPress={autoCrop} style={styles.editorIconBtn} accessibilityLabel="Auto recorte">
                <Ionicons name="flash-outline" size={18} color="#fff" />
              </TouchableOpacity>
            </View>

            {/* Selector de Filtro (solo esta imagen) */}
            {editingUri && (
              <View style={{ flexDirection: 'row', justifyContent: 'flex-start', alignItems: 'center', gap: 12, marginTop: 12 }}>
                <Text style={{ color: '#fff', fontWeight: '600' }}>Filtro:</Text>
                <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ alignItems: 'center', gap: 12 }}>
                  {(['none','grayscale','contrast','antimoire','enhance','document'] as const).map((f) => {
                    const active = (photoFilters[editingUri!] ?? 'none') === f;
                    const label = f === 'none'
                      ? 'Ninguno'
                      : f === 'grayscale'
                        ? 'B/N'
                        : f === 'contrast'
                          ? 'Contraste'
                          : f === 'antimoire'
                            ? 'Anti-moiré'
                            : f === 'document'
                              ? 'Documento'
                              : 'Mejora';
                    return (
                      <View key={f} style={{ alignItems: 'center' }}>
                        <TouchableOpacity
                          onPress={() => { setFilterForPhoto(editingUri!, f); pushHistory(); }}
                          style={[styles.editorIconBtn, active && { borderColor: colors.primary, backgroundColor: 'rgba(10,132,255,0.15)' }]}
                          accessibilityLabel={`Filtro ${label}`}
                        >
                          <Ionicons name={f === 'grayscale' ? 'contrast-outline' : 'color-filter-outline'} size={18} color="#fff" />
                        </TouchableOpacity>
                        <Text style={{ fontSize: 12, color: active ? colors.primary : colors.secondaryText, marginTop: 4 }}>{label}</Text>
                      </View>
                    );
                  })}
                </ScrollView>
              </View>
            )}

            {/* Barra de acción principal (glifos de trazo fino) */}
            <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginTop: 14 }}>
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
                <TouchableOpacity onPress={cancelEdit} style={styles.editorIconBtn} accessibilityLabel="Cerrar">
                  <Ionicons name="close-outline" size={18} color="#fff" />
                </TouchableOpacity>
                <TouchableOpacity onPress={handleUndo} disabled={!canUndo()} style={[styles.editorIconBtn, !canUndo() && { opacity: 0.5 }]} accessibilityLabel="Deshacer">
                  <Ionicons name="arrow-undo-outline" size={18} color="#fff" />
                </TouchableOpacity>
                <TouchableOpacity onPress={handleRedo} disabled={!canRedo()} style={[styles.editorIconBtn, !canRedo() && { opacity: 0.5 }]} accessibilityLabel="Rehacer">
                  <Ionicons name="arrow-redo-outline" size={18} color="#fff" />
                </TouchableOpacity>
              </View>
              <TouchableOpacity onPress={saveEdits} style={styles.editorIconBtn} accessibilityLabel="Guardar">
                <Ionicons name="checkmark-outline" size={18} color="#fff" />
              </TouchableOpacity>
            </View>
          </View>
        </View>
      </Modal>
      {creatingPdf && (
        <View style={styles.loadingOverlay}>
          <ActivityIndicator size="large" color="#fff" />
          <Text style={{ color: '#fff', marginTop: 10 }}>Creando PDF...</Text>
        </View>
      )}
      {switchingToPreview && (
        <View style={styles.loadingOverlay}>
          <ActivityIndicator size="large" color="#fff" />
          <Text style={{ color: '#fff', marginTop: 10 }}>Abriendo previsualización...</Text>
        </View>
      )}
      {toastMsg && (
        <View style={[styles.toast, { pointerEvents: 'none' }]}>
          <View style={styles.toastPill}>
            <Text style={styles.toastText}>{toastMsg}</Text>
          </View>
        </View>
      )}
      {pdfPreviewHtml && (
        <PdfPreviewModal
          html={pdfPreviewHtml}
          onClose={() => setPdfPreviewHtml(null)}
          onGoHome={() => { setPdfPreviewHtml(null); setMode('home'); }}
          onSave={savePdfFromPreview}
          onShare={sharePdfFromPreview}
          saving={savingPdf}
        />
      )}
    </SafeAreaView>
    {/* Modal de conversión */}
    <ConvertDocument visible={showConvertModal} onClose={() => setShowConvertModal(false)} />
    {/* Modal texto OCR (previsualización inmediata) */}
    <OcrTextPreviewModal
      visible={showOcrResult}
      text={ocrText}
      onClose={() => { setShowOcrResult(false); setOcrText(null); setOcrDownloadUrl(null); setOcrLocalPath(null); }}
    />
    <EditSavedPdfModal
      visible={showEditSavedModal}
      pdf={editingSaved}
      onClose={() => { setShowEditSavedModal(false); setEditingSaved(null); }}
      onRenamed={loadSavedPdfs}
      onStartCamera={(baseName) => { setPdfName(baseName); beginDniMode(); }}
    />
    </SafeAreaProvider>
  );
}

// Construir un DOCX simple a partir de texto plano
/**
 * Construye un archivo DOCX básico a partir de texto plano.
 * En web devuelve un Blob; en nativo devuelve base64.
 */
async function buildDocxFromText(text: string, titleOverride?: string): Promise<{ blob?: Blob; base64?: string; fileName: string }> {
  const now = new Date();
  const title = (titleOverride?.trim() || 'Texto OCR');
  const subtitle = `Generado en ScanPdf By The Kirv Studio • ${now.toLocaleString()}`;
  const lines = text.split(/\r?\n/);

  const headerParas = [
    new Paragraph({ text: title, heading: 'Heading1' as any }),
    new Paragraph({ text: subtitle }),
    new Paragraph({ text: '' }),
  ];

  const bodyParas = lines.map((t) => new Paragraph({
    children: [
      new TextRun({ text: t.replace(/\t/g, '    ') }),
    ],
    spacing: { line: 240 },
  }));

  const doc = new Document({
    sections: [{
      properties: {
        page: {
          margin: { top: 1440, bottom: 1440, left: 1440, right: 1440 },
        },
      },
      children: [...headerParas, ...bodyParas],
    }],
  });

  const safeBase = title.replace(/[^a-z0-9-_. ]/gi, '').trim() || 'ocr_text';
  const fileName = `${safeBase}_${now.getFullYear()}-${(now.getMonth()+1).toString().padStart(2,'0')}-${now.getDate().toString().padStart(2,'0')}.docx`;

  if (isWeb) {
    const blob = await Packer.toBlob(doc);
    return { blob, fileName };
  } else {
    const base64 = await Packer.toBase64String(doc);
    return { base64, fileName };
  }
}

function arrayBufferToBase64(buffer: ArrayBuffer) {
  let binary = '';
  const bytes = new Uint8Array(buffer);
  const len = bytes.byteLength;
  for (let i = 0; i < len; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  // @ts-ignore
  return globalThis.btoa ? btoa(binary) : Buffer.from(binary, 'binary').toString('base64');
}

// Modal de previsualización de PDF
// Nota: se renderiza dentro del árbol principal para mostrar WebView con HTML generado
export function PdfPreviewModal({ html, onClose, onGoHome, onSave, onShare, saving }: { html: string | null; onClose: () => void; onGoHome: () => void; onSave: () => void; onShare: () => void; saving: boolean }) {
  const colors = {
    primary: '#0a84ff',
    text: '#111827',
    secondaryText: '#6b7280',
  };
  const WebViewNative = (require('react-native-webview').WebView as any);
  if (!html) return null as any;
  return (
    <Modal visible animationType="slide" onRequestClose={onClose}>
      <SafeAreaView style={{ flex: 1, backgroundColor: '#fff' }}>
        <View style={{ paddingHorizontal: 12, paddingVertical: 8, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
            <TouchableOpacity onPress={onClose} accessibilityLabel="Volver atrás" style={{ padding: 8 }}>
              <Ionicons name="chevron-back" size={20} color={colors.text} />
            </TouchableOpacity>
            <TouchableOpacity onPress={onGoHome} accessibilityLabel="Volver al inicio" style={{ padding: 8 }}>
              <Ionicons name="home-outline" size={20} color={colors.text} />
            </TouchableOpacity>
          </View>
          <Text style={{ color: colors.text, fontWeight: '700', fontSize: 16 }}>Previsualización PDF</Text>
          <View style={{ width: 36 }} />
        </View>
        {/* Contenido con padding inferior para no quedar oculto por la barra */}
        <View style={{ flex: 1, paddingBottom: 120 }}>
          {isWeb ? (
            <ScrollView contentContainerStyle={{ padding: 12, gap: 12 }}>
              <Text style={{ color: colors.secondaryText }}>
                Abrí la previsualización en una pestaña nueva. Podés reabrirla o imprimir/guardar.
              </Text>
              <TouchableOpacity
                onPress={() => { try { const win = window.open('', '_blank'); if (win) { win.document.open(); win.document.write(html); win.document.close(); } } catch {} }}
                style={{ paddingVertical: 10, paddingHorizontal: 12, borderRadius: 999, borderWidth: 1, borderColor: '#d1d5db' }}
              >
                <Text style={{ color: colors.text, fontWeight: '600' }}>Abrir previsualización</Text>
              </TouchableOpacity>
              <TouchableOpacity
                onPress={async () => { try { await Print.printAsync({ html }); } catch {} }}
                style={{ paddingVertical: 12, paddingHorizontal: 16, borderRadius: 999, backgroundColor: colors.primary }}
              >
                <Text style={{ color: '#fff', fontWeight: '700' }}>Imprimir / Guardar como PDF</Text>
              </TouchableOpacity>
            </ScrollView>
          ) : (
            <WebViewNative originWhitelist={["*"]} source={{ html }} />
          )}
        </View>
        {/* Barra inferior fija con acciones */}
        <View style={{ position: 'absolute', left: 0, right: 0, bottom: 0, backgroundColor: '#fff', borderTopWidth: 1, borderTopColor: '#e5e7eb', padding: 12, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', zIndex: 10, elevation: 8 }}>
          <TouchableOpacity onPress={onSave} disabled={saving} style={[{ backgroundColor: colors.primary, paddingVertical: 12, paddingHorizontal: 16, borderRadius: 999, opacity: saving ? 0.6 : 1 }]}> 
            <Text style={{ color: '#fff', fontWeight: '700' }}>{saving ? 'Guardando…' : 'Guardar en la app'}</Text>
          </TouchableOpacity>
          {!isWeb && (
            <TouchableOpacity onPress={onShare} style={{ paddingVertical: 10, paddingHorizontal: 12, borderRadius: 999, borderWidth: 1, borderColor: '#d1d5db' }}> 
              <Text style={{ color: colors.text, fontWeight: '600' }}>Exportar</Text>
            </TouchableOpacity>
          )}
        </View>
      </SafeAreaView>
    </Modal>
  );
}

export function EditSavedPdfModal({ visible, pdf, onClose, onRenamed, onStartCamera }: { visible: boolean; pdf: { name: string; uri: string } | null; onClose: () => void; onRenamed: () => void; onStartCamera: (baseName: string) => void }) {
  const [newName, setNewName] = React.useState('');
  React.useEffect(() => {
    setNewName(pdf ? pdf.name.replace(/\.pdf$/i, '') : '');
  }, [pdf, visible]);

  const doRename = async () => {
    if (!pdf) return;
    try {
      const baseName = (newName || pdf.name).replace(/\.pdf$/i, '').trim();
      const safe = baseName.replace(/[^\w\-. ]+/g, '');
      if (!safe) {
        Alert.alert('Nombre inválido', 'Ingresa un nombre válido para el documento.');
        return;
      }
      const dir = pdf.uri.replace(/[^/]+$/, '');
      const dest = dir + safe + '.pdf';
      await FileSystem.moveAsync({ from: pdf.uri, to: dest });
      onRenamed();
      onClose();
      Alert.alert('Renombrado', 'El nombre del documento se actualizó.');
    } catch (e) {
      Alert.alert('Error', 'No se pudo renombrar el archivo.');
    }
  };

  const doShare = async () => {
    if (!pdf) return;
    try {
      await Sharing.shareAsync(pdf.uri);
    } catch (e) {
      Alert.alert('Compartir', 'No se pudo compartir el archivo.');
    }
  };

  const addImages = () => {
    if (!pdf) return;
    const base = newName || pdf.name.replace(/\.pdf$/i, '');
    onStartCamera(base);
    onClose();
  };

  return (
    <Modal visible={visible} animationType="slide" onRequestClose={onClose}>
      <SafeAreaView style={styles.safe}>
        <View style={styles.header}>
          <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
            <TouchableOpacity onPress={onClose} style={styles.navBtn} accessibilityLabel="Cerrar edición">
              <Ionicons name="chevron-back" size={20} color={colors.text} />
              <Text style={styles.navBtnText}>Volver</Text>
            </TouchableOpacity>
          </View>
          <Text style={styles.title}>Editar documento</Text>
        </View>
        <View style={styles.content}>
          <BlurView intensity={30} tint="light" style={styles.card}>
            <View style={{ gap: 12 }}>
              <Text style={styles.cardTitle}>Título del documento</Text>
              <TextInput
                value={newName}
                onChangeText={setNewName}
                placeholder="Nombre del documento"
                placeholderTextColor={colors.secondaryText}
                style={{ borderWidth: 1, borderColor: '#e5e7eb', borderRadius: 12, paddingHorizontal: 12, paddingVertical: 10, color: colors.text }}
              />
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
                <TouchableOpacity onPress={doRename} style={styles.primaryButton} accessibilityLabel="Guardar nombre">
                  <Text style={styles.primaryButtonText}>Guardar nombre</Text>
                </TouchableOpacity>
                {!isWeb && (
                  <TouchableOpacity onPress={doShare} style={[styles.editorGhostTextBtn, { borderWidth: 1, borderColor: '#d1d5db' }]} accessibilityLabel="Compartir">
                    <Text style={{ color: colors.text, fontWeight: '600' }}>Compartir</Text>
                  </TouchableOpacity>
                )}
                <TouchableOpacity onPress={addImages} style={[styles.editorGhostTextBtn, { borderWidth: 1, borderColor: '#d1d5db' }]} accessibilityLabel="Sumar imágenes">
                  <Text style={{ color: colors.text, fontWeight: '600' }}>Sumar imágenes</Text>
                </TouchableOpacity>
              </View>
            </View>
          </BlurView>
        </View>
      </SafeAreaView>
    </Modal>
  );
}

export function OcrTextPreviewModal({ visible, text, onClose }: { visible: boolean; text: string | null; onClose: () => void }) {
  const colors = {
    primary: '#0a84ff',
    text: '#111827',
    secondaryText: '#6b7280',
  };

  const [docTitle, setDocTitle] = useState<string>('Documento OCR');
  const [editableText, setEditableText] = useState<string>(text ?? '');

  useEffect(() => {
    if (visible) {
      setDocTitle((prev) => prev || 'Documento OCR');
      setEditableText(text ?? '');
    }
  }, [visible, text]);

  const handleSaveDocx = async () => {
    try {
      const content = editableText ?? '';
      if (!content.trim()) {
        Alert.alert('OCR', 'No hay texto para guardar.');
        return;
      }
      const { blob, base64, fileName } = await buildDocxFromText(content, docTitle);
      if (isWeb && blob) {
        const b64 = await blob.arrayBuffer().then(arrayBufferToBase64);
        const url = `data:application/vnd.openxmlformats-officedocument.wordprocessingml.document;base64,${b64}`;
        try {
          const a = document.createElement('a');
          a.href = url;
          a.download = fileName;
          document.body.appendChild(a);
          a.click();
          document.body.removeChild(a);
        } catch {
          window.open(url, '_blank');
        }
        Alert.alert('Guardado', 'Se descargó el archivo .docx');
      } else {
        const baseDir = FileSystem.cacheDirectory || FileSystem.documentDirectory || '';
        const path = baseDir + fileName;
        const dataB64 = base64 ?? (blob ? await blob.arrayBuffer().then(arrayBufferToBase64) : '');
        await FileSystem.writeAsStringAsync(path, dataB64, { encoding: (FileSystem as any).EncodingType?.Base64 || 'base64' } as any);
        const canShare = await Sharing.isAvailableAsync();
        if (canShare) {
          await Sharing.shareAsync(path, {
            dialogTitle: 'Compartir DOCX',
            UTI: 'org.openxmlformats.wordprocessingml.document',
            mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
          } as any);
        } else if (Platform.OS === 'android') {
          try {
            const contentUri = await (FileSystem as any).getContentUriAsync(path);
            await IntentLauncher.startActivityAsync(IntentLauncher.ActivityAction.VIEW, {
              data: contentUri,
              flags: 1,
              type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
            } as any);
          } catch (e) {
            Alert.alert('Archivo', `Guardado en: ${path}`);
          }
        } else {
          Alert.alert('Archivo', `Guardado en: ${path}`);
        }
      }
    } catch (e) {
      Alert.alert('OCR', 'No se pudo guardar el DOCX.');
    }
  };

  const handleCopyText = async () => {
    try {
      if (isWeb && editableText) {
        await navigator.clipboard.writeText(editableText);
        Alert.alert('Copiado', 'Texto copiado al portapapeles.');
      }
    } catch {}
  };

  return (
    <Modal visible={visible} animationType="slide" onRequestClose={onClose}>
      <SafeAreaView style={{ flex: 1, backgroundColor: '#fff' }}>
        <View style={{ paddingHorizontal: 12, paddingVertical: 8, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
          <Text style={{ color: colors.text, fontWeight: '700', fontSize: 16 }}>Texto OCR</Text>
          <TouchableOpacity onPress={onClose} accessibilityLabel="Cerrar" style={{ padding: 8 }}>
            <Ionicons name="close" size={20} color={colors.text} />
          </TouchableOpacity>
        </View>
        <ScrollView contentContainerStyle={{ padding: 12 }}>
          {!editableText || !editableText.trim() ? (
            <Text style={{ color: colors.secondaryText }}>No se detectó texto. Prueba con mejor iluminación, enfoque o cambia el idioma (Español/Inglés).</Text>
          ) : (
            <View style={{ gap: 12 }}>
              <TextInput
                value={docTitle}
                onChangeText={setDocTitle}
                placeholder="Título del documento"
                placeholderTextColor={colors.secondaryText}
                style={{ backgroundColor: '#f3f4f6', paddingVertical: 10, paddingHorizontal: 14, borderRadius: 12, color: colors.text }}
              />
              <TextInput
                value={editableText}
                onChangeText={setEditableText}
                placeholder="Editar texto OCR…"
                placeholderTextColor={colors.secondaryText}
                multiline
                textAlignVertical="top"
                style={{ backgroundColor: '#f8fafc', borderWidth: 1, borderColor: '#e5e7eb', borderRadius: 12, padding: 12, color: colors.text, fontSize: 14, lineHeight: 20, minHeight: 240 }}
              />
            </View>
          )}
        </ScrollView>
        <View style={{ position: 'absolute', left: 0, right: 0, bottom: 0, backgroundColor: '#fff', borderTopWidth: 1, borderTopColor: '#e5e7eb', padding: 12, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', zIndex: 10, elevation: 8 }}>
          <TouchableOpacity onPress={handleSaveDocx} style={{ backgroundColor: colors.primary, paddingVertical: 12, paddingHorizontal: 16, borderRadius: 999 }}>
            <Text style={{ color: '#fff', fontWeight: '700' }}>{isWeb ? 'Descargar DOCX' : 'Guardar/Compartir DOCX'}</Text>
          </TouchableOpacity>
          {isWeb && (
            <TouchableOpacity onPress={handleCopyText} style={{ paddingVertical: 10, paddingHorizontal: 12, borderRadius: 999, borderWidth: 1, borderColor: '#d1d5db' }}>
              <Text style={{ color: colors.text, fontWeight: '600' }}>Copiar texto</Text>
            </TouchableOpacity>
          )}
        </View>
      </SafeAreaView>
    </Modal>
  );
}

export function OcrResultModal({ visible, onClose, downloadUrl, localPath }: { visible: boolean; onClose: () => void; downloadUrl: string | null; localPath: string | null }) {
  const colors = {
    primary: '#0a84ff',
    text: '#111827',
    secondaryText: '#6b7280',
  };

  const handleOpen = async () => {
    try {
      if (isWeb) {
        if (downloadUrl) {
          try {
            const a = document.createElement('a');
            a.href = downloadUrl;
            a.download = 'ocr_text.docx';
            document.body.appendChild(a);
            a.click();
            document.body.removeChild(a);
          } catch {
            window.open(downloadUrl, '_blank');
          }
        }
      } else {
        if (localPath) {
          await Sharing.shareAsync(localPath, { dialogTitle: 'Abrir/Compartir DOCX' });
        }
      }
    } catch (e) {
      Alert.alert('OCR', 'No se pudo abrir el documento.');
    }
  };

  const handleShare = async () => {
    try {
      if (!isWeb && localPath) {
        await Sharing.shareAsync(localPath, { dialogTitle: 'Compartir DOCX' });
      }
    } catch (e) {
      Alert.alert('Compartir', 'No se pudo compartir el documento.');
    }
  };

  return (
    <Modal visible={visible} animationType="slide" onRequestClose={onClose}>
      <SafeAreaView style={{ flex: 1, backgroundColor: '#fff' }}>
        <View style={{ paddingHorizontal: 12, paddingVertical: 8, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
          <Text style={{ color: colors.text, fontWeight: '700', fontSize: 16 }}>Resultado OCR</Text>
          <TouchableOpacity onPress={onClose} accessibilityLabel="Cerrar" style={{ padding: 8 }}>
            <Ionicons name="close" size={20} color={colors.text} />
          </TouchableOpacity>
        </View>
        <ScrollView contentContainerStyle={{ padding: 12 }}>
          <View style={{ gap: 8 }}>
            <Text style={{ color: colors.secondaryText }}>
              Tu documento .docx está listo{isWeb ? ' para descargar.' : ' para abrir/compartir.'}
            </Text>
            {!!downloadUrl && isWeb && (
              <Text style={{ color: colors.secondaryText, fontSize: 12 }}>
                Consejo: si el botón no descarga, se abrirá en una nueva pestaña.
              </Text>
            )}
            {!!localPath && !isWeb && (
              <Text style={{ color: colors.secondaryText, fontSize: 12 }}>Ruta local: {localPath}</Text>
            )}
          </View>
        </ScrollView>
        <View style={{ position: 'absolute', left: 0, right: 0, bottom: 0, backgroundColor: '#fff', borderTopWidth: 1, borderTopColor: '#e5e7eb', padding: 12, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', zIndex: 10, elevation: 8 }}>
          <TouchableOpacity onPress={handleOpen} style={{ backgroundColor: colors.primary, paddingVertical: 12, paddingHorizontal: 16, borderRadius: 999 }}>
            <Text style={{ color: '#fff', fontWeight: '700' }}>{isWeb ? 'Descargar DOCX' : 'Abrir/Compartir'}</Text>
          </TouchableOpacity>
          {!isWeb && (
            <TouchableOpacity onPress={handleShare} style={{ paddingVertical: 10, paddingHorizontal: 12, borderRadius: 999, borderWidth: 1, borderColor: '#d1d5db' }}>
              <Text style={{ color: colors.text, fontWeight: '600' }}>Compartir</Text>
            </TouchableOpacity>
          )}
        </View>
      </SafeAreaView>
    </Modal>
  );
}

const colors = {
  primary: '#0a84ff',
  text: '#111827',
  secondaryText: '#6b7280',
  bg: '#ffffff',
};

const fontFamily = Platform.select({ ios: 'System', android: 'sans-serif', default: 'System' });

const styles = StyleSheet.create({
  safe: {
    flex: 1,
    backgroundColor: colors.bg,
  },
  header: {
    paddingHorizontal: 20,
    paddingTop: 12,
    paddingBottom: 24,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: '#e5e7eb',
  },
  title: {
    fontSize: 32,
    fontWeight: '700',
    color: colors.text,
    fontFamily,
    letterSpacing: 0.2,
  },
  subtitle: {
    marginTop: 6,
    fontSize: 16,
    color: colors.secondaryText,
    fontFamily,
  },
  content: {
    flex: 1,
    padding: 20,
    gap: 20,
  },
  thumbRow: {
    flexDirection: 'row',
    gap: 8,
  },
  thumb: {
    width: 56,
    height: 56,
    borderRadius: 12,
  },
  card: {
    borderRadius: 24,
    padding: 20,
    backgroundColor: 'rgba(255,255,255,0.6)',
    overflow: 'hidden',
    // Sombras estilo iOS / Android
    shadowColor: '#000',
    shadowOpacity: 0.08,
    shadowRadius: 12,
    shadowOffset: { width: 0, height: 6 },
    elevation: 4,
  },
  cardIconRow: {
    alignItems: 'flex-start',
    marginBottom: 8,
  },
  cardTitle: {
    fontSize: 20,
    fontWeight: '600',
    color: colors.text,
    fontFamily,
  },
  cardDesc: {
    marginTop: 4,
    fontSize: 14,
    color: colors.secondaryText,
    fontFamily,
  },
  featureGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    justifyContent: 'space-between',
    gap: 12,
  },
  featureCard: {
    width: '48%',
    borderRadius: 16,
    padding: 14,
    backgroundColor: 'rgba(255,255,255,0.7)',
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: '#e5e7eb',
    shadowColor: '#000',
    shadowOpacity: 0.06,
    shadowRadius: 8,
    shadowOffset: { width: 0, height: 4 },
    elevation: 3,
  },
  featureLabel: {
    marginTop: 8,
    fontSize: 14,
    fontWeight: '600',
    color: colors.text,
    fontFamily,
  },
  fab: {
    position: 'absolute',
    right: 20,
    bottom: 20,
    width: 56,
    height: 56,
    borderRadius: 28,
    backgroundColor: colors.primary,
    alignItems: 'center',
    justifyContent: 'center',
    shadowColor: '#000',
    shadowOpacity: 0.15,
    shadowRadius: 12,
    shadowOffset: { width: 0, height: 6 },
    elevation: 6,
  },
  primaryButton: {
    marginTop: 16,
    backgroundColor: colors.primary,
    paddingVertical: 14,
    borderRadius: 14,
    alignItems: 'center',
    // Sombras sutiles del botón
    shadowColor: '#0a84ff',
    shadowOpacity: 0.25,
    shadowRadius: 10,
    shadowOffset: { width: 0, height: 6 },
    elevation: 3,
  },
  primaryButtonText: {
    color: '#fff',
    fontSize: 16,
    fontWeight: '600',
    fontFamily,
    letterSpacing: 0.3,
  },
  footerNote: {
    alignItems: 'center',
  },
  noteText: {
    fontSize: 12,
    color: colors.secondaryText,
    fontFamily,
  },
  cameraContainer: {
    flex: 1,
    backgroundColor: '#000',
  },
  cameraTopBar: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    paddingTop: 8,
    paddingHorizontal: 12,
  },
  topBarBlur: {
    borderRadius: 16,
    padding: 8,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    margin: 12,
  },
  navBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
  },
  navBtnText: {
    color: colors.text,
    fontFamily,
    fontSize: 16,
    fontWeight: '600',
  },
  counterPill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    backgroundColor: 'transparent',
    paddingVertical: 6,
    paddingHorizontal: 10,
    borderRadius: 999,
  },
  counterText: {
    color: colors.text,
    fontFamily,
    fontSize: 14,
    fontWeight: '600',
  },
  cameraBottomBar: {
    position: 'absolute',
    bottom: 0,
    left: 0,
    right: 0,
    paddingBottom: 16,
    paddingHorizontal: 12,
  },
  bottomBarBlur: {
    borderRadius: 24,
    padding: 16,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginHorizontal: 12,
    marginBottom: 12,
  },
  shutterBtn: {
    width: 72,
    height: 72,
    borderRadius: 999,
    borderWidth: 4,
    borderColor: '#fff',
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'transparent',
  },
  shutterInner: {
    width: 48,
    height: 48,
    borderRadius: 999,
    backgroundColor: '#fff',
  },
  actionBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    backgroundColor: colors.primary,
    paddingVertical: 12,
    paddingHorizontal: 16,
    borderRadius: 14,
  },
  actionBtnText: {
    color: '#fff',
    fontFamily,
    fontWeight: '600',
    fontSize: 16,
  },
  handle: {
    position: 'absolute',
    width: 36,
    height: 36,
    borderRadius: 18,
    backgroundColor: colors.primary,
  },
  editorImage: {
    flex: 1,
  },
  editorIconBtn: {
    width: 44,
    height: 44,
    borderRadius: 22,
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.5)',
    backgroundColor: 'transparent',
    alignItems: 'center',
    justifyContent: 'center',
  },
  editorPrimaryPill: {
    backgroundColor: colors.primary,
    paddingVertical: 10,
    paddingHorizontal: 18,
    borderRadius: 18,
  },
  editorGhostTextBtn: {
    paddingVertical: 8,
    paddingHorizontal: 10,
    borderRadius: 12,
    backgroundColor: 'transparent',
  },
  imageTopActions: {
    position: 'absolute',
    top: 8,
    right: 8,
    flexDirection: 'row',
    gap: 8,
  },
  overlayIconBtn: {
    width: 36,
    height: 36,
    borderRadius: 18,
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.5)',
    backgroundColor: 'transparent',
    alignItems: 'center',
    justifyContent: 'center',
  },
  filterBadge: {
    position: 'absolute',
    top: 8,
    left: 8,
    backgroundColor: 'rgba(0,0,0,0.3)',
    paddingVertical: 4,
    paddingHorizontal: 8,
    borderRadius: 999,
  },
  filterBadgeText: {
    color: '#fff',
    fontFamily,
    fontSize: 12,
    fontWeight: '700',
  },
  filterBadgeSmall: {
    position: 'absolute',
    top: 4,
    left: 4,
    backgroundColor: 'rgba(0,0,0,0.35)',
    paddingVertical: 2,
    paddingHorizontal: 6,
    borderRadius: 999,
  },
  filterBadgeTextSmall: {
    color: '#fff',
    fontFamily,
    fontSize: 10,
    fontWeight: '700',
  },
  loadingOverlay: {
    position: 'absolute',
    left: 0,
    right: 0,
    top: 0,
    bottom: 0,
    backgroundColor: 'rgba(0,0,0,0.4)',
    alignItems: 'center',
    justifyContent: 'center',
    zIndex: 1000,
  },
  toast: {
    position: 'absolute',
    bottom: 24,
    left: 0,
    right: 0,
    alignItems: 'center',
    zIndex: 1001,
  },
  toastPill: {
    backgroundColor: 'rgba(17,17,17,0.9)',
    paddingVertical: 8,
    paddingHorizontal: 12,
    borderRadius: 999,
  },
  toastText: {
    color: '#fff',
    fontFamily,
    fontSize: 14,
    fontWeight: '600',
  },
});

  /**
   * Vista previa de imagen con filtros.
   * Web: aplica filtros CSS directamente.
   * Nativo: usa WebView para evitar artefactos de filtros SVG.
   */
  const FilteredPreview = ({ uri, filter, height, fit = 'cover' }: { uri: string; filter: 'none' | 'grayscale' | 'contrast' | 'antimoire' | 'enhance' | 'document'; height: number; fit?: 'contain' | 'cover' }) => {
    // Web: CSS filters directamente
    if (isWeb) {
      return (
        <View style={[{ width: '100%', height }, ({ filter: getCssFilter(filter) } as any)]}>
          <Image source={{ uri }} style={{ width: '100%', height: '100%' }} resizeMode={fit} />
        </View>
      );
    }

    // Nativo sin filtro: imagen directa
    if (filter === 'none') {
      return <Image source={{ uri }} style={{ width: '100%', height }} resizeMode={fit} />;
    }

    // Nativo con filtro: usar WebView + IMG con filtros CSS (evita distorsiones SVG)
    const base64CacheRef = useRef<Record<string, string>>({});
    const [html, setHtml] = useState<string | null>(null);
    const [loading, setLoading] = useState<boolean>(false);

    useEffect(() => {
      let mounted = true;
      const build = async () => {
        try {
          setLoading(true);
          // Obtener base64 de cache o leer archivo
          let b64 = base64CacheRef.current[uri];
          if (!b64) {
            b64 = await FileSystem.readAsStringAsync(uri, { encoding: 'base64' });
            base64CacheRef.current[uri] = b64;
          }
          const cssFilter = getCssFilter(filter);
          const objectFit = fit === 'contain' ? 'contain' : 'cover';
          // HTML simple con IMG y filtros CSS — evita artefactos geométricos del pipeline SVG
          const page = `<!DOCTYPE html><html><head><meta charset="utf-8" /><meta name="viewport" content="width=device-width, initial-scale=1" />
            <style>html,body{margin:0;padding:0;background:transparent;height:100%}img{width:100%;height:100%;object-fit:${objectFit};filter:${cssFilter};}</style></head><body>
            <img src="data:image/*;base64,${b64}" />
            </body></html>`;
          if (mounted) setHtml(page);
        } catch (e) {
          if (mounted) setHtml(null);
        } finally {
          if (mounted) setLoading(false);
        }
      };
      build();
      return () => { mounted = false; };
    }, [uri, filter]);

    const WebViewCmp = (require('react-native-webview').WebView as any);
    return (
      <View style={{ width: '100%', height }}>
        {html ? (
          <WebViewCmp originWhitelist={["*"]} source={{ html }} style={{ backgroundColor: 'transparent', width: '100%', height: '100%' }} />
        ) : (
          <Image source={{ uri }} style={{ width: '100%', height }} resizeMode={fit} />
        )}
        {loading && (
          <View style={{ position: 'absolute', left: 0, right: 0, top: 0, bottom: 0, alignItems: 'center', justifyContent: 'center' }}>
            <ActivityIndicator color={colors.primary} />
          </View>
        )}
      </View>
    );
  };