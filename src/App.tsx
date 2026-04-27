import React, { useState, useEffect, useRef, useMemo, ChangeEvent } from 'react';
import Papa from 'papaparse';
import { read, utils } from 'xlsx';
import { 
  QrCode, 
  Users, 
  Upload, 
  CheckCircle2, 
  XCircle, 
  Search, 
  Check, 
  RefreshCw,
  AlertCircle,
  Plus,
  Calendar,
  MapPin,
  Trash2,
  Lock,
  ShieldCheck,
  LogOut
} from 'lucide-react';
import { Attendee, Tab, Event } from './types';
import { cn } from './lib/utils';
import { motion, AnimatePresence } from 'motion/react';
const logo = "/src/logo.png";
import { db } from './firebase';
import { 
  collection, 
  query, 
  onSnapshot, 
  doc, 
  setDoc, 
  updateDoc, 
  addDoc, 
  deleteDoc,
  serverTimestamp, 
  orderBy,
  writeBatch,
  getDocs
} from 'firebase/firestore';
import { handleFirestoreError, OperationType } from './lib/firestore-errors';
import { ErrorBoundary } from './components/ErrorBoundary';

function AppContent() {
  const [events, setEvents] = useState<Event[]>([]);
  const [selectedEventId, setSelectedEventId] = useState<string | null>(() => localStorage.getItem('selectedEventId'));
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [unlockedEvents, setUnlockedEvents] = useState<Record<string, string>>(() => {
    const saved = localStorage.getItem('unlockedEvents');
    return saved ? JSON.parse(saved) : {};
  }); // eventId -> password
  const [attendees, setAttendees] = useState<Attendee[]>([]);
  const attendeesRef = useRef<Attendee[]>([]);
  const [activeTab, setActiveTab] = useState<Tab>(() => {
    return localStorage.getItem('selectedEventId') ? 'scan' : 'events';
  });
  const [searchQuery, setSearchQuery] = useState('');
  
  // Modal states
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [showPasswordModal, setShowPasswordModal] = useState<string | null>(null);
  const [modalInput, setModalInput] = useState('');
  const [modalError, setModalError] = useState<string | null>(null);
  const [pendingFile, setPendingFile] = useState<File | null>(null);
  const [showSetPasswordModal, setShowSetPasswordModal] = useState(false);
  const [showAdminLoginModal, setShowAdminLoginModal] = useState(false);
  const [showDeleteConfirm, setShowDeleteConfirm] = useState<string | null>(null);
  const [adminUser, setAdminUser] = useState('');
  const [isAdmin, setIsAdmin] = useState(() => localStorage.getItem('isAdmin') === 'true');

  const selectedEvent = useMemo(() => {
    return events.find(e => e.id === selectedEventId) || null;
  }, [events, selectedEventId]);
  const [lastScanResult, setLastScanResult] = useState<{
    success: boolean;
    message: string;
    attendee?: Attendee;
    isNew?: boolean;
    timestamp?: string;
  } | null>(null);
  const [scanHistory, setScanHistory] = useState<Array<{
    id: string;
    success: boolean;
    message: string;
    attendee?: Attendee;
    timestamp: string;
  }>>([]);
  const [isScannerActive, setIsScannerActive] = useState(false);
  const [cameraError, setCameraError] = useState<string | null>(null);
  const [csvError, setCsvError] = useState<string | null>(null);
  const [isUploading, setIsUploading] = useState(false);
  const [isDeleting, setIsDeleting] = useState(false);
  const [scannerRetry, setScannerRetry] = useState(0);
  const [lastSyncTime, setLastSyncTime] = useState<Date>(new Date());
  const html5QrCodeRef = useRef<any>(null);
  const lastScannedRef = useRef<{ code: string; time: number } | null>(null);

  // Audio System
  const playSound = (type: 'success' | 'error') => {
    try {
      const AudioContext = window.AudioContext || (window as any).webkitAudioContext;
      if (!AudioContext) return;
      
      const ctx = new AudioContext();
      // Resume context if suspended (common in some browsers)
      if (ctx.state === 'suspended') {
        ctx.resume();
      }

      const osc = ctx.createOscillator();
      const gain = ctx.createGain();

      osc.connect(gain);
      gain.connect(ctx.destination);

      if (type === 'success') {
        // High pitched bright double beep - Triangle wave is much more audible
        osc.type = 'triangle';
        
        // Pulse 1
        osc.frequency.setValueAtTime(880, ctx.currentTime);
        gain.gain.setValueAtTime(0, ctx.currentTime);
        gain.gain.linearRampToValueAtTime(0.8, ctx.currentTime + 0.01);
        gain.gain.linearRampToValueAtTime(0, ctx.currentTime + 0.1);
        
        // Pulse 2
        osc.frequency.setValueAtTime(1100, ctx.currentTime + 0.12);
        gain.gain.setValueAtTime(0, ctx.currentTime + 0.12);
        gain.gain.linearRampToValueAtTime(0.8, ctx.currentTime + 0.13);
        gain.gain.linearRampToValueAtTime(0, ctx.currentTime + 0.25);
        
        osc.start(ctx.currentTime);
        osc.stop(ctx.currentTime + 0.3);
      } else {
        // Low harsh buzz - Sawtooth is already quite loud
        osc.type = 'sawtooth';
        osc.frequency.setValueAtTime(150, ctx.currentTime);
        osc.frequency.linearRampToValueAtTime(100, ctx.currentTime + 0.4);
        
        gain.gain.setValueAtTime(0, ctx.currentTime);
        gain.gain.linearRampToValueAtTime(0.6, ctx.currentTime + 0.01);
        gain.gain.exponentialRampToValueAtTime(0.01, ctx.currentTime + 0.5);
        
        osc.start(ctx.currentTime);
        osc.stop(ctx.currentTime + 0.5);
      }

      // Close context after sound finishes to free resources
      setTimeout(() => ctx.close(), 1000);
    } catch (e) {
      console.error("Audio error:", e);
    }
  };

  // Persistence & History
  useEffect(() => {
    if (selectedEventId) {
      localStorage.setItem('selectedEventId', selectedEventId);
      // Push state to history for back button support
      if (window.history.state?.eventId !== selectedEventId) {
        window.history.pushState({ eventId: selectedEventId }, '', '');
      }
    } else {
      localStorage.removeItem('selectedEventId');
      // If we are going back to events list, ensure history reflects it
      if (window.history.state?.eventId) {
        window.history.pushState({ eventId: null }, '', '');
      }
    }
  }, [selectedEventId]);

  useEffect(() => {
    const handlePopState = (event: PopStateEvent) => {
      if (event.state && event.state.eventId !== undefined) {
        setSelectedEventId(event.state.eventId);
      } else {
        setSelectedEventId(null);
      }
    };

    window.addEventListener('popstate', handlePopState);
    return () => window.removeEventListener('popstate', handlePopState);
  }, []);

  useEffect(() => {
    localStorage.setItem('unlockedEvents', JSON.stringify(unlockedEvents));
  }, [unlockedEvents]);

  useEffect(() => {
    localStorage.setItem('isAdmin', isAdmin.toString());
  }, [isAdmin]);

  // Events Listener
  useEffect(() => {
    const q = query(collection(db, 'events'), orderBy('createdAt', 'desc'));
    const unsubscribe = onSnapshot(q, (snapshot) => {
      const eventsData = snapshot.docs.map(doc => ({
        id: doc.id,
        ...doc.data()
      })) as Event[];
      setEvents(eventsData);
    }, (error) => {
      handleFirestoreError(error, OperationType.LIST, 'events');
    });

    return () => unsubscribe();
  }, []);

  // Attendees Listener
  useEffect(() => {
    if (!selectedEventId) {
      setAttendees([]);
      return;
    }

    // Find the current event to check password
    const currentEvent = events.find(e => e.id === selectedEventId);
    if (!currentEvent) return;

    // If event has a password and it's not unlocked, don't load attendees
    if (currentEvent.password && !unlockedEvents[selectedEventId]) {
      setAttendees([]);
      return;
    }

    const q = collection(db, 'events', selectedEventId, 'attendees');
    
    // Optimization: This listener only runs when the selected event or its unlock status changes.
    // Firestore's onSnapshot is smart: after the first load (which costs N reads), 
    // it only consumes 1 read per change, and switching tabs doesn't trigger a reload.
    const unsubscribe = onSnapshot(q, (snapshot) => {
      const attendeesData = snapshot.docs.map(doc => ({
        id: doc.id,
        ...doc.data()
      })) as Attendee[];
      setAttendees(attendeesData);
      attendeesRef.current = attendeesData;
      setLastSyncTime(new Date());
    }, (error) => {
      handleFirestoreError(error, OperationType.LIST, `events/${selectedEventId}/attendees`);
    });

    return () => unsubscribe();
  }, [selectedEventId, unlockedEvents[selectedEventId], !!events.find(e => e.id === selectedEventId)]);

  const createEvent = async (name: string) => {
    if (!isAdmin) return;
    if (!name.trim()) return;
    try {
      const docRef = await addDoc(collection(db, 'events'), {
        name: name.trim(),
        createdAt: serverTimestamp()
      });
      setShowCreateModal(false);
      setModalInput('');
      setSelectedEventId(docRef.id);
      setActiveTab('scan');
    } catch (error) {
      handleFirestoreError(error, OperationType.CREATE, 'events');
    }
  };

  const handleEventUnlock = (eventId: string, password?: string) => {
    const event = events.find(e => e.id === eventId);
    if (!event) return;

    if (event.password) {
      if (password === event.password) {
        setUnlockedEvents(prev => ({ ...prev, [event.id]: password }));
        setSelectedEventId(event.id);
        setActiveTab('scan');
        setShowPasswordModal(null);
        setModalInput('');
        setModalError(null);
      } else {
        setModalError("Contraseña incorrecta");
      }
    } else {
      setSelectedEventId(event.id);
      setActiveTab('scan');
    }
  };

  const deleteEvent = async (eventId: string) => {
    if (!isAdmin || isDeleting) return;
    setIsDeleting(true);
    try {
      // Delete attendees first in chunks of 500
      const attendeesRef = collection(db, 'events', eventId, 'attendees');
      const snapshot = await getDocs(attendeesRef);
      
      const chunks = [];
      for (let i = 0; i < snapshot.docs.length; i += 500) {
        chunks.push(snapshot.docs.slice(i, i + 500));
      }

      for (const chunk of chunks) {
        const batch = writeBatch(db);
        chunk.forEach(doc => batch.delete(doc.ref));
        await batch.commit();
      }
      
      // Delete event
      await deleteDoc(doc(db, 'events', eventId));
      if (selectedEventId === eventId) setSelectedEventId(null);
      setShowDeleteConfirm(null);
    } catch (error) {
      handleFirestoreError(error, OperationType.DELETE, `events/${eventId}`);
    } finally {
      setIsDeleting(false);
    }
  };

  const handleFileUpload = async (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file || !selectedEvent) return;

    // Define password on first upload if not set
    if (!selectedEvent.password) {
      setPendingFile(file);
      setShowSetPasswordModal(true);
      setModalInput('');
      return;
    } 
    
    // Check password if event has one and not unlocked
    if (unlockedEvents[selectedEvent.id] !== selectedEvent.password) {
      setPendingFile(file);
      setShowPasswordModal(selectedEvent.id);
      setModalInput('');
      setModalError(null);
      return;
    }

    processFileUpload(file);
  };

  const processFileUpload = (file: File) => {
    if (!selectedEvent) return;
    setCsvError(null);
    setIsUploading(true);

    const isExcel = file.name.endsWith('.xlsx') || file.name.endsWith('.xls');

    if (isExcel) {
      const reader = new FileReader();
      reader.onload = async (e) => {
        try {
          const data = e.target?.result;
          const workbook = read(data, { type: 'binary' });
          const sheetName = workbook.SheetNames[0];
          const worksheet = workbook.Sheets[sheetName];
          const jsonData = utils.sheet_to_json(worksheet);
          
          await handleParsedData(jsonData as any[]);
        } catch (error) {
          setCsvError('Error al procesar el archivo Excel: ' + (error instanceof Error ? error.message : String(error)));
          setIsUploading(false);
        }
      };
      reader.onerror = () => {
        setCsvError('Error al leer el archivo.');
        setIsUploading(false);
      };
      reader.readAsBinaryString(file);
    } else {
      Papa.parse(file, {
        header: true,
        skipEmptyLines: true,
        encoding: "UTF-8",
        complete: async (results) => {
          await handleParsedData(results.data as any[]);
        },
        error: (error) => {
          setCsvError('Error al procesar el archivo CSV: ' + error.message);
          setIsUploading(false);
        }
      });
    }
  };

  const handleParsedData = async (data: any[]) => {
    if (!selectedEvent) return;
    
    if (data.length === 0) {
      setCsvError('El archivo está vacío.');
      setIsUploading(false);
      return;
    }

    if (!data[0].hasOwnProperty('Código QR')) {
      setCsvError('El archivo no tiene la columna requerida "Código QR".');
      setIsUploading(false);
      return;
    }

    try {
      let batch = writeBatch(db);
      let currentBatchSize = 0;
      const attendeesCol = collection(db, 'events', selectedEvent.id, 'attendees');
      
      for (let i = 0; i < data.length; i++) {
        const row = data[i];
        const qrCode = (row['Código QR'] || '').toString().trim();
        
        if (!qrCode) continue;

        const attendeeData: Attendee = {
          Nombre: row.Nombre || '',
          Apellidos: row.Apellidos || '',
          'Correo electrónico': row['Correo electrónico'] || '',
          'Fecha de compra': row['Fecha de compra'] || '',
          'Tipo de entrada': row['Tipo de entrada'] || '',
          'Precio original': row['Precio original'] || '',
          'Gastos de gestion': row['Gastos de gestion'] || '',
          'Cupon usado': row['Cupon usado'] || '',
          'Codigo del cupon': row['Codigo del cupon'] || '',
          'Descuento aplicado': row['Descuento aplicado'] || '',
          'Precio pagado': row['Precio pagado'] || '',
          'Ticket ID': row['Ticket ID'] || '',
          'Código QR': qrCode,
          'Pregunta en Checkout': row['Pregunta en Checkout'] || '',
          'Respuesta en Checkout': row['Respuesta en Checkout'] || '',
          validated: false,
        };
        
        const safeId = qrCode.replace(/[\/\.\#\$\/\[\]]/g, '_');
        const docRef = doc(attendeesCol, safeId);
        batch.set(docRef, attendeeData);
        currentBatchSize++;

        if (currentBatchSize >= 500 || i === data.length - 1) {
          if (currentBatchSize > 0) {
            await batch.commit();
            batch = writeBatch(db);
            currentBatchSize = 0;
          }
        }
      }
      
      setIsUploading(false);
      setLastScanResult(null);
      alert(`¡Éxito! Se han procesado ${data.length} filas del archivo correctamente.`);
    } catch (error) {
      handleFirestoreError(error, OperationType.WRITE, `events/${selectedEvent.id}/attendees`);
      setIsUploading(false);
    }
  };

  const validateTicket = async (qrCode: string) => {
    const now = Date.now();
    if (lastScannedRef.current && 
        lastScannedRef.current.code === qrCode && 
        now - lastScannedRef.current.time < 4000) {
      return;
    }

    // Actualizar el ref inmediatamente para bloquear escaneos duplicados instantáneos
    lastScannedRef.current = { code: qrCode, time: now };

    const currentAttendees = attendeesRef.current;
    const attendee = currentAttendees.find(a => a['Código QR'] === qrCode);
    
    const timestamp = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
    
    if (!attendee) {
      const result = { 
        success: false, 
        message: 'Código no encontrado',
        isNew: true,
        timestamp,
        qrCode
      };
      setLastScanResult(result);
      playSound('error');
      
      setTimeout(() => {
        setLastScanResult(prev => (prev?.isNew && prev.message === 'Código no encontrado' ? { ...prev, isNew: false } : prev));
        setScanHistory(prev => [{ id: crypto.randomUUID(), ...result, isNew: false }, ...prev].slice(0, 100));
      }, 500);
      return;
    }

    if (attendee.validated) {
      const result = { 
        success: false, 
        message: 'Ya validada', 
        attendee,
        isNew: true,
        timestamp,
        qrCode
      };
      setLastScanResult(result);
      playSound('error');
      
      setTimeout(() => {
        setLastScanResult(prev => (prev?.isNew && prev.attendee?.['Código QR'] === qrCode ? { ...prev, isNew: false } : prev));
        setScanHistory(prev => [{ id: crypto.randomUUID(), ...result, isNew: false }, ...prev].slice(0, 100));
      }, 500);
      return;
    }

    try {
      // ACTUALIZACIÓN OPTIMISTA
      const result = {
        success: true,
        message: 'Validada',
        attendee: { ...attendee, validated: true },
        isNew: true,
        timestamp,
        qrCode
      };
      setLastScanResult(result);
      playSound('success');

      // Pasar de central a inferior después de 0.5s
      setTimeout(() => {
        setLastScanResult(prev => {
          if (prev?.isNew) {
            return { ...prev, isNew: false };
          }
          return prev;
        });
        setScanHistory(prev => [{ id: crypto.randomUUID(), ...result, isNew: false }, ...prev].slice(0, 100));
      }, 500);

      // Limpiar central después de 5s
      setTimeout(() => {
        setLastScanResult(prev => {
          if (prev && !prev.isNew) return null;
          return prev;
        });
      }, 5000);

      if (selectedEvent) {
        const attendeeRef = doc(db, 'events', selectedEvent.id, 'attendees', qrCode.replace(/\//g, '_'));
        await updateDoc(attendeeRef, {
          validated: true,
          validationTime: timestamp
        });
      }
    } catch (error) {
      lastScannedRef.current = null;
      handleFirestoreError(error, OperationType.UPDATE, `events/${selectedEvent?.id}/attendees/${qrCode}`);
    }
  };

  const toggleManualValidation = async (attendee: Attendee) => {
    if (!selectedEvent) return;
    try {
      const timestamp = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
      const attendeeRef = doc(db, 'events', selectedEvent.id, 'attendees', attendee['Código QR'].replace(/\//g, '_'));
      await updateDoc(attendeeRef, {
        validated: !attendee.validated,
        validationTime: !attendee.validated ? timestamp : null
      });
    } catch (error) {
      handleFirestoreError(error, OperationType.UPDATE, `events/${selectedEvent.id}/attendees/${attendee['Código QR']}`);
    }
  };

  const resetData = () => {
    // No longer needed as we use events
  };

  useEffect(() => {
    let isMounted = true;
    let scanner: any = null;

    const initScanner = async () => {
      if (activeTab === 'scan' && attendees.length > 0 && selectedEvent) {
        setCameraError(null);
        setIsScannerActive(false);
        
        // Wait for AnimatePresence and DOM rendering
        await new Promise(resolve => setTimeout(resolve, 1500));
        if (!isMounted) return;

        let readerElement = document.getElementById("reader");
        if (!readerElement) {
          // One last attempt to find the element
          await new Promise(resolve => setTimeout(resolve, 500));
          readerElement = document.getElementById("reader");
        }
        
        if (!readerElement || readerElement.clientWidth === 0) {
          console.warn("Reader element not ready or has no width");
          return;
        }

        try {
          // Check for camera support
          if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
            throw new Error("Tu navegador no soporta el acceso a la cámara o no estás en una conexión segura (HTTPS).");
          }

          const { Html5Qrcode } = await import('html5-qrcode');
          
          // Cleanup any global state if possible
          if (html5QrCodeRef.current) {
            try {
              const oldScanner = html5QrCodeRef.current;
              if (oldScanner.isScanning) {
                await oldScanner.stop();
              }
              if (typeof oldScanner.clear === 'function') {
                await oldScanner.clear();
              }
            } catch (e) {
              console.warn("Cleanup of previous scanner failed", e);
            }
            html5QrCodeRef.current = null;
          }

          scanner = new Html5Qrcode("reader", { verbose: false });
          
          const config = { 
            fps: 20, 
            qrbox: { width: 280, height: 280 },
            aspectRatio: 1.0,
            showTorchButtonIfSupported: true
          };

          let targetCameraId: any = { facingMode: "environment" };
          
          try {
            const cameras = await Html5Qrcode.getCameras();
            if (cameras && cameras.length > 0) {
              const back = cameras.find(c => /back|trasera|rear|environment/i.test(c.label));
              targetCameraId = back ? back.id : cameras[0].id;
            }
          } catch (e) {
            console.warn("getCameras failed, falling back to facingMode", e);
          }

          if (isMounted) {
            await scanner.start(
              targetCameraId, 
              config,
              (decodedText: string) => {
                validateTicket(decodedText);
              },
              () => {}
            );
          }
          
          if (isMounted) {
            html5QrCodeRef.current = scanner;
            setIsScannerActive(true);
          } else {
            if (scanner.isScanning) await scanner.stop();
            if (typeof scanner.clear === 'function') await scanner.clear();
          }
        } catch (err: any) {
          console.error("Scanner start error:", err);
          if (isMounted) {
            let msg = "No se pudo iniciar la cámara.";
            if (err?.message?.includes("Permission denied")) msg = "Permiso de cámara denegado. Por favor, actívalo en los ajustes del navegador.";
            else if (err?.message?.includes("NotFound")) msg = "No se encontró ninguna cámara disponible.";
            else msg = err?.message || msg;
            
            setCameraError(msg);
            setIsScannerActive(false);
          }
        }
      }
    };

    initScanner();

    return () => {
      isMounted = false;
      if (scanner) {
        const s = scanner;
        const cleanup = async () => {
          try {
            if (s.isScanning) {
              await s.stop();
            }
            if (typeof s.clear === 'function') {
              // Only clear if the element still exists in DOM to avoid removeChild errors
              if (document.getElementById("reader")) {
                await s.clear();
              }
            }
          } catch (e) {
            // Ignore cleanup errors as they are usually DOM-related during unmount
          }
        };
        cleanup();
      }
      html5QrCodeRef.current = null;
    };
  }, [activeTab, attendees.length, selectedEvent, scannerRetry]);

  const filteredAttendees = useMemo(() => {
    return attendees.filter(a => {
      const fullName = `${a.Nombre} ${a.Apellidos}`.toLowerCase();
      return fullName.includes(searchQuery.toLowerCase());
    });
  }, [attendees, searchQuery]);

  const stats = useMemo(() => {
    const total = attendees.length;
    const validated = attendees.filter(a => a.validated).length;
    const percent = total > 0 ? Math.round((validated / total) * 100) : 0;
    return { total, validated, percent };
  }, [attendees]);

  const handleAdminLogin = () => {
    if (adminUser === 'linkolnpark' && modalInput === 'LPeslapolla26') {
      setIsAdmin(true);
      setShowAdminLoginModal(false);
      setAdminUser('');
      setModalInput('');
      setModalError(null);
    } else {
      setModalError('Usuario o contraseña incorrectos');
    }
  };

  const modalsUI = (
    <AnimatePresence>
      {showDeleteConfirm && (
        <motion.div 
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          className="fixed inset-0 bg-black/60 backdrop-blur-sm z-[110] flex items-center justify-center p-4"
          onClick={() => setShowDeleteConfirm(null)}
        >
          <motion.div 
            initial={{ scale: 0.9, opacity: 0, y: 20 }}
            animate={{ scale: 1, opacity: 1, y: 0 }}
            exit={{ scale: 0.9, opacity: 0, y: 20 }}
            className="bg-white rounded-3xl shadow-2xl max-w-sm w-full p-8"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="w-16 h-16 bg-red-50 rounded-2xl flex items-center justify-center text-red-600 mx-auto mb-6">
              <Trash2 className="w-8 h-8" />
            </div>
            <h3 className="text-xl font-bold text-neutral-900 text-center mb-2">¿Eliminar evento?</h3>
            <p className="text-neutral-500 text-center mb-8 text-sm">
              Esta acción eliminará permanentemente el evento y todos sus asistentes. No se puede deshacer.
            </p>
            <div className="flex gap-3">
              <button 
                onClick={() => setShowDeleteConfirm(null)}
                disabled={isDeleting}
                className="flex-1 bg-neutral-100 hover:bg-neutral-200 text-neutral-600 font-bold py-4 rounded-2xl transition-all disabled:opacity-50"
              >
                Cancelar
              </button>
              <button 
                onClick={() => deleteEvent(showDeleteConfirm)}
                disabled={isDeleting}
                className="flex-1 bg-red-600 hover:bg-red-700 text-white font-bold py-4 rounded-2xl transition-all shadow-lg shadow-red-100 disabled:opacity-50 flex items-center justify-center gap-2"
              >
                {isDeleting ? (
                  <>
                    <RefreshCw className="w-5 h-5 animate-spin" />
                    <span>Eliminando...</span>
                  </>
                ) : (
                  <span>Eliminar</span>
                )}
              </button>
            </div>
          </motion.div>
        </motion.div>
      )}

      {(showCreateModal || showPasswordModal || showSetPasswordModal || showAdminLoginModal) && (
        <motion.div 
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          className="fixed inset-0 bg-black/60 backdrop-blur-sm z-[100] flex items-center justify-center p-4"
          onClick={() => {
            setShowCreateModal(false);
            setShowPasswordModal(null);
            setShowSetPasswordModal(false);
            setShowAdminLoginModal(false);
            setModalInput('');
            setAdminUser('');
            setModalError(null);
            setPendingFile(null);
          }}
        >
          <motion.div 
            initial={{ scale: 0.9, opacity: 0, y: 20 }}
            animate={{ scale: 1, opacity: 1, y: 0 }}
            exit={{ scale: 0.9, opacity: 0, y: 20 }}
            className="bg-white rounded-3xl shadow-2xl max-w-md w-full p-8"
            onClick={(e) => e.stopPropagation()}
          >
            <h3 className="text-2xl font-bold text-neutral-900 mb-2">
              {showCreateModal ? 'Nuevo Evento' : 
               showAdminLoginModal ? 'Acceso Administrador' :
               showSetPasswordModal ? 'Definir Contraseña' : 'Acceso Protegido'}
            </h3>
            <p className="text-neutral-500 mb-6">
              {showCreateModal ? 'Introduce el nombre de la ciudad y el año.' : 
               showAdminLoginModal ? 'Introduce tus credenciales de administrador.' :
               showSetPasswordModal ? 'Define una contraseña para este evento. Se pedirá a cualquiera que quiera acceder.' : 
               'Este evento está protegido. Introduce la contraseña para continuar.'}
            </p>

            <div className="space-y-4">
              {showAdminLoginModal && (
                <div>
                  <input 
                    type="text"
                    value={adminUser}
                    onChange={(e) => setAdminUser(e.target.value)}
                    placeholder="Usuario"
                    className="w-full bg-neutral-100 border-none rounded-2xl px-6 py-4 focus:ring-2 focus:ring-blue-500 transition-all mb-4"
                    autoFocus
                  />
                </div>
              )}
              <div>
                <input 
                  type={showCreateModal ? "text" : "password"}
                  value={modalInput}
                  onChange={(e) => setModalInput(e.target.value)}
                  placeholder={showCreateModal ? "Ej: Getafe 2026" : "Contraseña"}
                  className="w-full bg-neutral-100 border-none rounded-2xl px-6 py-4 focus:ring-2 focus:ring-blue-500 transition-all"
                  autoFocus={!showAdminLoginModal}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                      if (showCreateModal) createEvent(modalInput);
                      else if (showAdminLoginModal) handleAdminLogin();
                      else if (showPasswordModal) handleEventUnlock(showPasswordModal, modalInput);
                      else if (showSetPasswordModal && selectedEvent) {
                        const eventRef = doc(db, 'events', selectedEvent.id);
                        updateDoc(eventRef, { password: modalInput });
                        setUnlockedEvents(prev => ({ ...prev, [selectedEvent.id]: modalInput }));
                        setShowSetPasswordModal(false);
                        if (pendingFile) processFileUpload(pendingFile);
                        setModalInput('');
                      }
                    }
                  }}
                />
                {modalError && <p className="text-red-500 text-xs font-bold mt-2 ml-2">{modalError}</p>}
              </div>

              <div className="flex gap-3">
                <button 
                  onClick={() => {
                    setShowCreateModal(false);
                    setShowPasswordModal(null);
                    setShowSetPasswordModal(false);
                    setShowAdminLoginModal(false);
                    setModalInput('');
                    setAdminUser('');
                    setModalError(null);
                    setPendingFile(null);
                  }}
                  className="flex-1 bg-neutral-100 hover:bg-neutral-200 text-neutral-600 font-bold py-4 rounded-2xl transition-all"
                >
                  Cancelar
                </button>
                <button 
                  onClick={() => {
                    if (showCreateModal) createEvent(modalInput);
                    else if (showAdminLoginModal) handleAdminLogin();
                    else if (showPasswordModal) handleEventUnlock(showPasswordModal, modalInput);
                    else if (showSetPasswordModal && selectedEvent) {
                      const eventRef = doc(db, 'events', selectedEvent.id);
                      updateDoc(eventRef, { password: modalInput });
                      setUnlockedEvents(prev => ({ ...prev, [selectedEvent.id]: modalInput }));
                      setShowSetPasswordModal(false);
                      if (pendingFile) processFileUpload(pendingFile);
                      setModalInput('');
                    }
                  }}
                  className="flex-1 bg-blue-600 hover:bg-blue-700 text-white font-bold py-4 rounded-2xl transition-all shadow-lg shadow-blue-100"
                >
                  Confirmar
                </button>
              </div>
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );

  if (!selectedEvent) {
    return (
      <div className="min-h-screen bg-neutral-50 flex flex-col font-sans">
        <header className="bg-white border-b border-neutral-200 px-4 py-3 sticky top-0 z-30">
          <div className="max-w-4xl mx-auto flex items-center justify-center">
            <h1 className="font-black text-blue-600 leading-tight tracking-tighter text-xl">TICKETBOOM VALIDATOR</h1>
          </div>
        </header>

        <main className="flex-1 max-w-4xl w-full mx-auto p-6">
          <div className="flex items-center justify-between mb-8">
            <h2 className="text-2xl font-bold text-neutral-900">Mis Eventos</h2>
            <div className="flex gap-2">
              {!isAdmin ? (
                <button 
                  onClick={() => setShowAdminLoginModal(true)}
                  className="flex items-center gap-2 bg-neutral-200 hover:bg-neutral-300 text-neutral-700 px-4 py-2 rounded-xl text-sm font-bold transition-all active:scale-95"
                >
                  <Lock className="w-4 h-4" />
                  <span>Admin</span>
                </button>
              ) : (
                <div className="flex gap-2">
                  <button 
                    onClick={() => setIsAdmin(false)}
                    className="flex items-center gap-2 bg-red-50 text-red-600 px-4 py-2 rounded-xl text-sm font-bold transition-all active:scale-95 border border-red-100"
                  >
                    <LogOut className="w-4 h-4" />
                    <span>Salir</span>
                  </button>
                  <button 
                    onClick={() => setShowCreateModal(true)}
                    className="flex items-center gap-2 bg-blue-600 hover:bg-blue-700 text-white px-4 py-2 rounded-xl text-sm font-bold transition-all active:scale-95 shadow-lg shadow-blue-100"
                  >
                    <Plus className="w-4 h-4" />
                    <span>Nuevo Evento</span>
                  </button>
                </div>
              )}
            </div>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            {events.length > 0 ? (
              events.map((event) => (
                <motion.div
                  key={event.id}
                  whileHover={{ y: -4 }}
                  whileTap={{ scale: 0.98 }}
                  onClick={() => {
                    if (event.password && !unlockedEvents[event.id]) {
                      setShowPasswordModal(event.id);
                      setModalInput('');
                      setModalError(null);
                    } else {
                      setSelectedEventId(event.id);
                      setActiveTab('scan');
                    }
                  }}
                  role="button"
                  tabIndex={0}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' || e.key === ' ') {
                      if (event.password && !unlockedEvents[event.id]) {
                        setShowPasswordModal(event.id);
                        setModalInput('');
                        setModalError(null);
                      } else {
                        setSelectedEventId(event.id);
                        setActiveTab('scan');
                      }
                    }
                  }}
                  className="bg-white border border-neutral-100 rounded-3xl p-6 text-left shadow-sm hover:shadow-md transition-all group cursor-pointer"
                >
                  <div className="flex items-start justify-between mb-4">
                    <div className="w-12 h-12 bg-blue-50 rounded-2xl flex items-center justify-center text-blue-600 group-hover:bg-blue-600 group-hover:text-white transition-colors">
                      <Calendar className="w-6 h-6" />
                    </div>
                    <div className="flex flex-col items-end gap-2">
                      <div className="text-[10px] font-bold text-neutral-400 uppercase tracking-widest">
                        {event.createdAt?.toDate ? event.createdAt.toDate().toLocaleDateString() : 'Reciente'}
                      </div>
                      {isAdmin && (
                        <button 
                          onClick={(e) => {
                            e.stopPropagation();
                            setShowDeleteConfirm(event.id);
                          }}
                          className="p-2 text-neutral-300 hover:text-red-500 transition-colors"
                        >
                          <Trash2 className="w-4 h-4" />
                        </button>
                      )}
                    </div>
                  </div>
                  <h3 className="text-xl font-bold text-neutral-900 mb-1">{event.name}</h3>
                  <div className="flex items-center gap-2 text-neutral-500 text-sm">
                    <MapPin className="w-4 h-4" />
                    <span>Seleccionar para validar</span>
                  </div>
                </motion.div>
              ))
            ) : (
              <div className="col-span-full text-center py-20 bg-white rounded-3xl border border-dashed border-neutral-200">
                <Calendar className="w-12 h-12 text-neutral-200 mx-auto mb-4" />
                <p className="text-neutral-500 font-medium">No hay eventos creados todavía</p>
              </div>
            )}
          </div>
        </main>
        {modalsUI}
      </div>
    );
  }

  if (attendees.length === 0) {
    return (
      <div className="min-h-screen bg-neutral-50 flex flex-col font-sans">
        <header className="bg-white border-b border-neutral-200 px-4 py-3">
          <div className="max-w-4xl mx-auto flex items-center justify-between">
            <button onClick={() => setSelectedEventId(null)} className="text-sm font-bold text-blue-600 hover:text-blue-700">
              ← Volver a Eventos
            </button>
            <h1 className="font-bold text-neutral-900">{selectedEvent.name}</h1>
            <div className="w-10" />
          </div>
        </header>

        <div className="flex-1 flex flex-col items-center justify-center p-6 text-center">
          <motion.div 
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            className="max-w-md w-full bg-white rounded-3xl shadow-xl p-8 border border-neutral-100"
          >
            <div className="mb-8 flex justify-center">
              <div className="w-20 h-20 bg-blue-50 rounded-2xl flex items-center justify-center text-blue-600">
                <Upload className="w-10 h-10" />
              </div>
            </div>
            <h2 className="text-2xl font-bold text-neutral-900 mb-2">Cargar Asistentes</h2>
            <p className="text-neutral-500 mb-8">Sube el listado de asistentes (CSV o Excel) para {selectedEvent.name} para empezar la validación sincronizada.</p>
            
            {csvError && (
              <div className="mb-6 p-4 bg-red-50 border border-red-100 rounded-2xl flex items-start gap-3 text-left">
                <AlertCircle className="w-5 h-5 text-red-600 shrink-0 mt-0.5" />
                <p className="text-sm text-red-800 font-medium">{csvError}</p>
              </div>
            )}

            <div className="relative group">
              <input 
                ref={fileInputRef}
                type="file" 
                accept=".csv, .xlsx, .xls, text/csv, application/csv, text/x-csv, application/x-csv, text/comma-separated-values, application/vnd.ms-excel, application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" 
                onChange={handleFileUpload}
                disabled={isUploading}
                className="hidden"
              />
              <button 
                onClick={() => fileInputRef.current?.click()}
                disabled={isUploading}
                className={cn(
                  "w-full flex items-center justify-center gap-2 text-white font-semibold py-4 px-6 rounded-2xl transition-all shadow-lg active:scale-95",
                  isUploading ? "bg-neutral-400 cursor-not-allowed" : "bg-blue-600 hover:bg-blue-700 shadow-blue-200 cursor-pointer"
                )}
              >
                {isUploading ? <RefreshCw className="w-5 h-5 animate-spin" /> : <Upload className="w-5 h-5" />}
                <span>{isUploading ? 'Subiendo...' : 'Cargar Listado (CSV/Excel)'}</span>
              </button>
            </div>
          </motion.div>
        </div>
        {modalsUI}
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-neutral-50 flex flex-col font-sans pb-24">
      {/* Header */}
      <header className="bg-white border-b border-neutral-200 px-4 py-2 sticky top-0 z-30">
        <div className="max-w-4xl mx-auto flex items-center justify-between">
          <div className="flex items-center gap-2">
            <button onClick={() => setSelectedEventId(null)} className="text-blue-600 font-bold text-sm flex items-center gap-1">
              <span className="text-lg">←</span> {selectedEvent.name}
            </button>
          </div>
          <h1 className="font-black text-blue-600 leading-tight tracking-tighter text-sm hidden sm:block">TICKETBOOM VALIDATOR</h1>
          <div className="flex items-center gap-2">
              <button 
                onClick={() => {
                  const input = document.createElement('input');
                  input.type = 'file';
                  input.accept = '.csv, .xlsx, .xls, application/vnd.openxmlformats-officedocument.spreadsheetml.sheet, application/vnd.ms-excel';
                  input.onchange = (e: any) => handleFileUpload(e);
                  input.click();
                }}
                className="flex items-center gap-2 bg-neutral-100 hover:bg-neutral-200 text-neutral-700 px-3 py-2 rounded-xl text-xs font-bold transition-all active:scale-95"
                title="Actualizar listado (CSV/Excel)"
              >
                <Upload className="w-4 h-4" />
                <span>Reemplazar Excel/CSV</span>
              </button>
          </div>
        </div>
      </header>

      {/* Stats Bar */}
      <div className="bg-white border-b border-neutral-100 px-4 py-2">
        <div className="max-w-4xl mx-auto grid grid-cols-3 gap-2">
          <div className="bg-neutral-50 rounded-lg p-1.5 text-center border border-neutral-100">
            <p className="text-[8px] text-neutral-400 uppercase font-bold tracking-wider mb-0">Total</p>
            <p className="text-base font-bold text-neutral-900">{stats.total}</p>
          </div>
          <div className="bg-green-50 rounded-lg p-1.5 text-center border border-green-100">
            <p className="text-[8px] text-green-600 uppercase font-bold tracking-wider mb-0">Validadas</p>
            <p className="text-base font-bold text-green-700">{stats.validated}</p>
          </div>
          <div className="bg-blue-50 rounded-lg p-1.5 text-center border border-blue-100 flex flex-col items-center justify-center">
            <div className="flex items-center gap-1 mb-0.5">
              <div className="w-1.5 h-1.5 bg-blue-500 rounded-full animate-pulse" />
              <p className="text-[8px] text-blue-600 uppercase font-bold tracking-wider">Sincronizado</p>
            </div>
            <p className="text-[10px] font-bold text-blue-700">{lastSyncTime.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}</p>
          </div>
        </div>
        <div className="max-w-4xl mx-auto mt-1.5 h-1 bg-neutral-100 rounded-full overflow-hidden">
          <motion.div 
            initial={{ width: 0 }}
            animate={{ width: `${stats.percent}%` }}
            className="h-full bg-blue-600"
          />
        </div>
      </div>

      {/* Main Content */}
      <main className="flex-1 max-w-4xl w-full mx-auto p-3 md:p-6 overflow-hidden">
        <AnimatePresence mode="wait">
          {activeTab === 'scan' ? (
            <motion.div 
              key="scan"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              className="flex flex-col gap-3 h-full max-h-full"
            >
              <div className="relative bg-black rounded-2xl overflow-hidden aspect-square max-w-[280px] w-full mx-auto shadow-2xl border-2 border-white shrink-0">
                <div id="reader" key={`reader-${scannerRetry}`} className="w-full h-full"></div>
                
                {/* Scanning Frame Overlay */}
                <div className="absolute inset-0 border-[30px] border-black/40 pointer-events-none">
                  <div className="w-full h-full border-2 border-white/20 rounded-2xl relative">
                    <div className="absolute -top-1 -left-1 w-6 h-6 border-t-4 border-l-4 border-white rounded-tl-md"></div>
                    <div className="absolute -top-1 -right-1 w-6 h-6 border-t-4 border-r-4 border-white rounded-tr-md"></div>
                    <div className="absolute -bottom-1 -left-1 w-6 h-6 border-b-4 border-l-4 border-white rounded-bl-md"></div>
                    <div className="absolute -bottom-1 -right-1 w-6 h-6 border-b-4 border-r-4 border-white rounded-br-md"></div>
                  </div>
                </div>

                {/* Central Overlay for new scans */}
                {lastScanResult?.isNew && (
                  <div className="absolute inset-0 z-50 flex items-center justify-center p-4 bg-black/40 backdrop-blur-[2px] pointer-events-none">
                    <div className={cn(
                      "w-full max-w-[240px] rounded-3xl p-5 shadow-2xl border-4 flex flex-col items-center gap-3 text-center",
                      lastScanResult.success 
                        ? "bg-green-500 border-green-400 text-white" 
                        : "bg-red-500 border-red-400 text-white"
                    )}>
                      <div className="w-16 h-16 rounded-full bg-white/20 flex items-center justify-center mb-1">
                        {lastScanResult.success 
                          ? <CheckCircle2 className="w-10 h-10 text-white" /> 
                          : <XCircle className="w-10 h-10 text-white" />
                        }
                      </div>
                      <div>
                        <h2 className="text-lg font-black mb-1 leading-tight uppercase text-white">{lastScanResult.message}</h2>
                        {lastScanResult.attendee && (
                          <div className="bg-black/20 px-3 py-1.5 rounded-xl mt-1">
                            <p className="text-base font-bold truncate max-w-[180px] text-white">
                              {lastScanResult.attendee.Nombre}
                            </p>
                            <p className="text-xs opacity-90 truncate max-w-[180px] text-white">
                              {lastScanResult.attendee.Apellidos}
                            </p>
                          </div>
                        )}
                      </div>
                    </div>
                  </div>
                )}

                {!isScannerActive && !cameraError && (
                  <div className="absolute inset-0 flex flex-col items-center justify-center bg-neutral-900 text-white p-6 text-center">
                    <RefreshCw className="w-8 h-8 animate-spin mb-4 text-blue-500" />
                    <p className="text-sm font-medium">Iniciando cámara...</p>
                    <button 
                      onClick={() => setScannerRetry(prev => prev + 1)}
                      className="mt-4 text-xs text-blue-400 underline"
                    >
                      ¿Tarda demasiado? Reintentar
                    </button>
                  </div>
                )}
                {cameraError && (
                  <div className="absolute inset-0 flex flex-col items-center justify-center bg-neutral-900 text-white p-8 text-center">
                    <XCircle className="w-12 h-12 text-red-500 mb-4" />
                    <p className="font-bold text-lg mb-2">Cámara Bloqueada</p>
                    <p className="text-xs text-neutral-400 mb-6">{cameraError}</p>
                    <div className="flex flex-col gap-3 w-full">
                      <button 
                        onClick={() => setScannerRetry(prev => prev + 1)}
                        className="bg-blue-600 text-white px-6 py-3 rounded-2xl font-bold text-sm active:scale-95 transition-all shadow-lg shadow-blue-900/20"
                      >
                        Reintentar Permisos
                      </button>
                      <button 
                        onClick={() => setActiveTab('list')}
                        className="bg-neutral-800 text-white px-6 py-3 rounded-2xl font-bold text-sm active:scale-95 transition-all"
                      >
                        Validar Manualmente
                      </button>
                    </div>
                  </div>
                )}
              </div>

              {/* Scan Result History */}
              <div className="flex-1 min-h-0 flex flex-col mt-2 border-t border-neutral-200 pt-2 overflow-hidden">
                <div className="flex-1 overflow-y-auto px-1 space-y-1.5 scrollbar-hide pb-4">
                  {scanHistory.map((scan, index) => (
                    <div 
                      key={scan.id}
                      className={cn(
                        "w-full rounded-lg px-2 py-1 shadow-sm border flex items-center gap-2",
                        scan.success 
                          ? "bg-green-50 border-green-100 text-green-900" 
                          : "bg-red-50 border-red-100 text-red-900",
                        index === 0 && lastScanResult && !lastScanResult.isNew ? "border-2 border-blue-500 ring-2 ring-blue-500/10" : "opacity-90"
                      )}
                    >
                      <div className={cn(
                        "w-5 h-5 rounded-full flex items-center justify-center shrink-0",
                        scan.success ? "bg-green-200" : "bg-red-200"
                      )}>
                        {scan.success ? <CheckCircle2 className="w-3 h-3" /> : <XCircle className="w-3 h-3" />}
                      </div>
                      <div className="flex-1 min-w-0">
                        <div className="flex justify-between items-center h-4">
                          <h3 className="font-black text-[9px] uppercase tracking-wider truncate">
                            {scan.message}
                          </h3>
                          <span className="text-[8px] opacity-40 font-mono font-bold bg-black/5 px-1 rounded">
                            {scan.timestamp}
                          </span>
                        </div>
                        {scan.attendee && (
                          <div className="flex justify-between items-center gap-2">
                            <p className="text-[10px] font-bold truncate opacity-80 leading-none">
                              {scan.attendee.Nombre} {scan.attendee.Apellidos}
                            </p>
                            <span className="text-[8px] opacity-30 font-mono shrink-0">#{scan.qrCode}</span>
                          </div>
                        )}
                        {!scan.attendee && scan.qrCode && (
                          <p className="text-[8px] opacity-30 font-mono truncate">ID: {scan.qrCode}</p>
                        )}
                      </div>
                    </div>
                  ))}

                  {scanHistory.length === 0 && !lastScanResult?.isNew && (
                    <div className="h-full flex flex-col items-center justify-center text-neutral-400 py-8">
                      <QrCode className="w-10 h-10 opacity-10 mb-1" />
                      <p className="text-[10px] font-bold uppercase tracking-widest opacity-30">Sin Validaciones</p>
                    </div>
                  )}
                </div>
              </div>
            </motion.div>
          ) : (
            <motion.div 
              key="list"
              initial={{ opacity: 0, x: 20 }}
              animate={{ opacity: 1, x: 0 }}
              exit={{ opacity: 0, x: -20 }}
              className="space-y-3 h-full flex flex-col"
            >
              <div className="relative shrink-0">
                <Search className="absolute left-4 top-1/2 -translate-y-1/2 w-5 h-5 text-neutral-400" />
                <input 
                  type="text"
                  placeholder="Buscar por nombre o apellidos..."
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  className="w-full bg-white border border-neutral-200 rounded-2xl py-3 pl-12 pr-4 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent shadow-sm transition-all text-sm"
                />
              </div>

              <div className="flex-1 overflow-y-auto -mx-3 px-3 pb-20">
                <div className="space-y-3">
                  {filteredAttendees.length > 0 ? (
                    filteredAttendees.map((attendee) => (
                    <div 
                      key={attendee['Código QR']}
                      className={cn(
                        "bg-white border rounded-2xl p-4 flex items-center justify-between transition-all",
                        attendee.validated ? "border-green-100 bg-green-50/30" : "border-neutral-100"
                      )}
                    >
                      <div className="flex-1 min-w-0">
                        <h3 className="font-bold text-neutral-900 truncate">
                          {attendee.Nombre} {attendee.Apellidos}
                        </h3>
                        <div className="flex items-center gap-2 mt-1">
                          <p className="text-[10px] text-neutral-500 truncate font-medium">{attendee['Tipo de entrada']}</p>
                          {attendee.validated && (
                            <div className="flex items-center gap-1.5 bg-green-100/50 text-green-700 px-2 py-0.5 rounded-full">
                              <Check className="w-2.5 h-2.5" />
                              <span className="text-[9px] font-black uppercase tracking-tight">
                                {attendee.validationTime || 'Validado'}
                              </span>
                            </div>
                          )}
                        </div>
                      </div>
                      <button 
                        onClick={() => toggleManualValidation(attendee)}
                        className={cn(
                          "w-12 h-12 rounded-xl flex items-center justify-center transition-all active:scale-90",
                          attendee.validated 
                            ? "bg-green-600 text-white shadow-lg shadow-green-100" 
                            : "bg-neutral-100 text-neutral-400 hover:bg-neutral-200"
                        )}
                      >
                        {attendee.validated ? <Check className="w-6 h-6" /> : <Users className="w-5 h-5" />}
                      </button>
                    </div>
                  ))
                ) : (
                  <div className="text-center py-12 bg-white rounded-3xl border border-dashed border-neutral-200">
                    <Users className="w-12 h-12 text-neutral-200 mx-auto mb-4" />
                    <p className="text-neutral-500 font-medium">No se encontraron asistentes</p>
                  </div>
                )}
              </div>
            </div>
          </motion.div>
        )}
        </AnimatePresence>
      </main>

      {/* Bottom Navigation */}
      <nav className="fixed bottom-0 left-0 right-0 bg-white border-t border-neutral-200 px-6 py-2 z-40 shadow-[0_-4px_20px_rgba(0,0,0,0.05)]">
        <div className="max-w-md mx-auto flex items-center justify-around gap-2">
          <button 
            onClick={() => setActiveTab('scan')}
            className={cn(
              "flex flex-col items-center gap-0.5 flex-1 py-1 rounded-xl transition-all",
              activeTab === 'scan' ? "text-blue-600 bg-blue-50" : "text-neutral-400 hover:text-neutral-600"
            )}
          >
            <QrCode className="w-5 h-5" />
            <span className="text-[9px] font-black uppercase tracking-wider">Escanear</span>
          </button>
          <button 
            onClick={() => setActiveTab('list')}
            className={cn(
              "flex flex-col items-center gap-0.5 flex-1 py-1 rounded-xl transition-all",
              activeTab === 'list' ? "text-blue-600 bg-blue-50" : "text-neutral-400 hover:text-neutral-600"
            )}
          >
            <Users className="w-5 h-5" />
            <span className="text-[9px] font-black uppercase tracking-wider">Asistentes</span>
          </button>
          <button 
            onClick={() => setSelectedEventId(null)}
            className="flex flex-col items-center gap-0.5 flex-1 py-1 rounded-xl transition-all text-neutral-400 hover:text-neutral-600"
          >
            <Calendar className="w-5 h-5" />
            <span className="text-[9px] font-black uppercase tracking-wider">Eventos</span>
          </button>
        </div>
      </nav>
      {modalsUI}
    </div>
  );
}

export default function App() {
  return (
    <ErrorBoundary>
      <AppContent />
    </ErrorBoundary>
  );
}
