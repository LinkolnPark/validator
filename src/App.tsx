import React, { useState, useEffect, useRef, useMemo, ChangeEvent } from 'react';
import Papa from 'papaparse';
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
  Trash2
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
  const [selectedEventId, setSelectedEventId] = useState<string | null>(null);
  const [unlockedEvents, setUnlockedEvents] = useState<Record<string, string>>({}); // eventId -> password
  const [attendees, setAttendees] = useState<Attendee[]>([]);
  const attendeesRef = useRef<Attendee[]>([]);
  const [activeTab, setActiveTab] = useState<Tab>('events');
  const [searchQuery, setSearchQuery] = useState('');
  
  // Modal states
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [showPasswordModal, setShowPasswordModal] = useState<string | null>(null);
  const [modalInput, setModalInput] = useState('');
  const [modalError, setModalError] = useState<string | null>(null);
  const [pendingFile, setPendingFile] = useState<File | null>(null);
  const [showSetPasswordModal, setShowSetPasswordModal] = useState(false);

  const selectedEvent = useMemo(() => {
    return events.find(e => e.id === selectedEventId) || null;
  }, [events, selectedEventId]);
  const [lastScanResult, setLastScanResult] = useState<{
    success: boolean;
    message: string;
    attendee?: Attendee;
  } | null>(null);
  const [isScannerActive, setIsScannerActive] = useState(false);
  const [cameraError, setCameraError] = useState<string | null>(null);
  const [csvError, setCsvError] = useState<string | null>(null);
  const [isUploading, setIsUploading] = useState(false);
  const html5QrCodeRef = useRef<any>(null);
  const lastScannedRef = useRef<{ code: string; time: number } | null>(null);

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
    if (!selectedEvent) {
      setAttendees([]);
      return;
    }

    // If event has a password and it's not unlocked, don't load attendees
    if (selectedEvent.password && !unlockedEvents[selectedEvent.id]) {
      setAttendees([]);
      return;
    }

    const q = collection(db, 'events', selectedEvent.id, 'attendees');
    const unsubscribe = onSnapshot(q, (snapshot) => {
      const attendeesData = snapshot.docs.map(doc => ({
        id: doc.id,
        ...doc.data()
      })) as Attendee[];
      setAttendees(attendeesData);
      attendeesRef.current = attendeesData;
    }, (error) => {
      handleFirestoreError(error, OperationType.LIST, `events/${selectedEvent.id}/attendees`);
    });

    return () => unsubscribe();
  }, [selectedEvent, unlockedEvents]);

  const createEvent = async (name: string) => {
    if (!name.trim()) return;
    try {
      await addDoc(collection(db, 'events'), {
        name: name.trim(),
        createdAt: serverTimestamp()
      });
      setShowCreateModal(false);
      setModalInput('');
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
        setShowPasswordModal(null);
        setModalInput('');
        setModalError(null);
      } else {
        setModalError("Contraseña incorrecta");
      }
    } else {
      setSelectedEventId(event.id);
    }
  };

  const deleteEvent = async (eventId: string) => {
    if (!confirm("¿Estás seguro de que quieres eliminar este evento y todos sus asistentes?")) return;
    try {
      // Delete attendees first (optional but cleaner)
      const attendeesRef = collection(db, 'events', eventId, 'attendees');
      const snapshot = await getDocs(attendeesRef);
      const batch = writeBatch(db);
      snapshot.docs.forEach(doc => batch.delete(doc.ref));
      await batch.commit();
      
      // Delete event
      await deleteDoc(doc(db, 'events', eventId));
      if (selectedEventId === eventId) setSelectedEventId(null);
    } catch (error) {
      handleFirestoreError(error, OperationType.DELETE, `events/${eventId}`);
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

    Papa.parse(file, {
      header: true,
      skipEmptyLines: true,
      complete: async (results) => {
        const data = results.data as any[];
        
        if (data.length === 0) {
          setCsvError('El archivo CSV está vacío.');
          setIsUploading(false);
          return;
        }

        if (!data[0].hasOwnProperty('Código QR')) {
          setCsvError('El archivo CSV no tiene la columna requerida "Código QR".');
          setIsUploading(false);
          return;
        }

        try {
          const batch = writeBatch(db);
          const attendeesCol = collection(db, 'events', selectedEvent.id, 'attendees');
          
          // Process in chunks of 500 (Firestore batch limit)
          for (let i = 0; i < data.length; i++) {
            const row = data[i];
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
              'Código QR': row['Código QR'] || '',
              'Pregunta en Checkout': row['Pregunta en Checkout'] || '',
              'Respuesta en Checkout': row['Respuesta en Checkout'] || '',
              validated: false,
            };
            
            // Use QR code as ID to prevent duplicates
            const docRef = doc(attendeesCol, attendeeData['Código QR'].replace(/\//g, '_'));
            batch.set(docRef, attendeeData);

            if ((i + 1) % 500 === 0 || i === data.length - 1) {
              await batch.commit();
            }
          }
          setIsUploading(false);
          setLastScanResult(null);
        } catch (error) {
          handleFirestoreError(error, OperationType.WRITE, `events/${selectedEvent.id}/attendees`);
          setIsUploading(false);
        }
      },
      error: (error) => {
        setCsvError('Error al procesar el archivo CSV: ' + error.message);
        setIsUploading(false);
      }
    });
  };

  const validateTicket = async (qrCode: string) => {
    const now = Date.now();
    if (lastScannedRef.current && 
        lastScannedRef.current.code === qrCode && 
        now - lastScannedRef.current.time < 5000) {
      return;
    }

    const currentAttendees = attendeesRef.current;
    const attendee = currentAttendees.find(a => a['Código QR'] === qrCode);
    
    if (!attendee) {
      setLastScanResult({ success: false, message: 'Código no encontrado' });
      return;
    }

    if (attendee.validated) {
      setLastScanResult({ success: false, message: 'Entrada ya validada', attendee });
      lastScannedRef.current = { code: qrCode, time: now };
      return;
    }

    try {
      const attendeeRef = doc(db, 'events', selectedEvent!.id, 'attendees', qrCode.replace(/\//g, '_'));
      await updateDoc(attendeeRef, {
        validated: true,
        validationTime: new Date().toLocaleTimeString()
      });
      
      setLastScanResult({
        success: true,
        message: 'Entrada validada correctamente',
        attendee: { ...attendee, validated: true }
      });
      lastScannedRef.current = { code: qrCode, time: now };

      setTimeout(() => {
        setLastScanResult(prev => {
          if (prev?.attendee?.['Código QR'] === qrCode) return null;
          return prev;
        });
      }, 3000);
    } catch (error) {
      handleFirestoreError(error, OperationType.UPDATE, `events/${selectedEvent!.id}/attendees/${qrCode}`);
    }
  };

  const toggleManualValidation = async (attendee: Attendee) => {
    if (!selectedEvent) return;
    try {
      const attendeeRef = doc(db, 'events', selectedEvent.id, 'attendees', attendee['Código QR'].replace(/\//g, '_'));
      await updateDoc(attendeeRef, {
        validated: !attendee.validated,
        validationTime: !attendee.validated ? new Date().toLocaleTimeString() : null
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
    let scannerInstance: any = null;

    const initScanner = async () => {
      if (activeTab === 'scan' && attendees.length > 0) {
        setCameraError(null);
        setIsScannerActive(false);
        
        // Wait for AnimatePresence and DOM rendering
        await new Promise(resolve => setTimeout(resolve, 400));
        if (!isMounted) return;

        const readerElement = document.getElementById("reader");
        if (!readerElement) {
          console.error("Reader element not found");
          return;
        }

        try {
          const { Html5Qrcode } = await import('html5-qrcode');
          scannerInstance = new Html5Qrcode("reader");
          
          const config = { 
            fps: 15, 
            qrbox: { width: 250, height: 250 },
            aspectRatio: 1.0
          };

          // Try to get all cameras and find the main one (usually not wide/ultra-wide)
          const cameras = await Html5Qrcode.getCameras();
          let targetCameraId: any = { facingMode: "environment" };

          if (cameras && cameras.length > 0) {
            // Filter for back cameras (usually don't mention "front" or "selfie")
            const backCameras = cameras.filter(c => 
              !c.label.toLowerCase().includes('front') && 
              !c.label.toLowerCase().includes('selfie') &&
              !c.label.toLowerCase().includes('delantera')
            );

            if (backCameras.length > 0) {
              // Among back cameras, prefer one that doesn't mention "wide" or "ultra"
              const mainCamera = backCameras.find(c => 
                !c.label.toLowerCase().includes('wide') && 
                !c.label.toLowerCase().includes('ultra') &&
                !c.label.toLowerCase().includes('gran angular')
              );
              
              if (mainCamera) {
                targetCameraId = mainCamera.id;
              } else {
                // If all back cameras are wide, just take the first back camera
                targetCameraId = backCameras[0].id;
              }
            } else {
              // If no back cameras found by label, fallback to environment constraint
              targetCameraId = { facingMode: "environment" };
            }
          }

          await scannerInstance.start(
            targetCameraId, 
            config,
            (decodedText: string) => {
              validateTicket(decodedText);
            },
            () => {
              // Ignore scan failures
            }
          );
          
          if (isMounted) {
            html5QrCodeRef.current = scannerInstance;
            setIsScannerActive(true);
          } else {
            await scannerInstance.stop();
          }
        } catch (err: any) {
          console.error("Scanner start error:", err);
          if (isMounted) {
            setCameraError("No se pudo iniciar la cámara. Asegúrate de dar permisos y que no esté en uso por otra pestaña.");
            setIsScannerActive(false);
          }
        }
      }
    };

    initScanner();

    return () => {
      isMounted = false;
      const cleanup = async () => {
        if (scannerInstance) {
          try {
            if (scannerInstance.isScanning) {
              await scannerInstance.stop();
            }
          } catch (e) {
            console.error("Scanner cleanup error:", e);
          }
        }
        html5QrCodeRef.current = null;
      };
      cleanup();
    };
  }, [activeTab, attendees.length]);

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

  const modalsUI = (
    <AnimatePresence>
      {(showCreateModal || showPasswordModal || showSetPasswordModal) && (
        <motion.div 
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          className="fixed inset-0 bg-black/60 backdrop-blur-sm z-[100] flex items-center justify-center p-4"
          onClick={() => {
            setShowCreateModal(false);
            setShowPasswordModal(null);
            setShowSetPasswordModal(false);
            setModalInput('');
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
               showSetPasswordModal ? 'Definir Contraseña' : 'Acceso Protegido'}
            </h3>
            <p className="text-neutral-500 mb-6">
              {showCreateModal ? 'Introduce el nombre de la ciudad y el año.' : 
               showSetPasswordModal ? 'Define una contraseña para este evento. Se pedirá a cualquiera que quiera acceder.' : 
               'Este evento está protegido. Introduce la contraseña para continuar.'}
            </p>

            <div className="space-y-4">
              <div>
                <input 
                  type={showCreateModal ? "text" : "password"}
                  value={modalInput}
                  onChange={(e) => setModalInput(e.target.value)}
                  placeholder={showCreateModal ? "Ej: Getafe 2026" : "Contraseña"}
                  className="w-full bg-neutral-100 border-none rounded-2xl px-6 py-4 focus:ring-2 focus:ring-blue-500 transition-all"
                  autoFocus
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                      if (showCreateModal) createEvent(modalInput);
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
                    setModalInput('');
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
          <div className="max-w-4xl mx-auto flex items-center justify-between">
            <div className="flex items-center gap-2">
              <img src={logo} alt="TB" className="w-8 h-8 object-contain" />
              <h1 className="font-bold text-neutral-900 leading-tight">Ticketboom</h1>
            </div>
          </div>
        </header>

        <main className="flex-1 max-w-4xl w-full mx-auto p-6">
          <div className="flex items-center justify-between mb-8">
            <h2 className="text-2xl font-bold text-neutral-900">Mis Eventos</h2>
            <button 
              onClick={() => setShowCreateModal(true)}
              className="flex items-center gap-2 bg-blue-600 hover:bg-blue-700 text-white px-4 py-2 rounded-xl text-sm font-bold transition-all active:scale-95 shadow-lg shadow-blue-100"
            >
              <Plus className="w-4 h-4" />
              <span>Nuevo Evento</span>
            </button>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            {events.length > 0 ? (
              events.map((event) => (
                <motion.button
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
                    }
                  }}
                  className="bg-white border border-neutral-100 rounded-3xl p-6 text-left shadow-sm hover:shadow-md transition-all group"
                >
                  <div className="flex items-start justify-between mb-4">
                    <div className="w-12 h-12 bg-blue-50 rounded-2xl flex items-center justify-center text-blue-600 group-hover:bg-blue-600 group-hover:text-white transition-colors">
                      <Calendar className="w-6 h-6" />
                    </div>
                    <div className="flex flex-col items-end gap-2">
                      <div className="text-[10px] font-bold text-neutral-400 uppercase tracking-widest">
                        {event.createdAt?.toDate ? event.createdAt.toDate().toLocaleDateString() : 'Reciente'}
                      </div>
                      <button 
                        onClick={(e) => {
                          e.stopPropagation();
                          deleteEvent(event.id);
                        }}
                        className="p-2 text-neutral-300 hover:text-red-500 transition-colors"
                      >
                        <Trash2 className="w-4 h-4" />
                      </button>
                    </div>
                  </div>
                  <h3 className="text-xl font-bold text-neutral-900 mb-1">{event.name}</h3>
                  <div className="flex items-center gap-2 text-neutral-500 text-sm">
                    <MapPin className="w-4 h-4" />
                    <span>Seleccionar para validar</span>
                  </div>
                </motion.button>
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
            <p className="text-neutral-500 mb-8">Sube el CSV para {selectedEvent.name} para empezar la validación sincronizada.</p>
            
            {csvError && (
              <div className="mb-6 p-4 bg-red-50 border border-red-100 rounded-2xl flex items-start gap-3 text-left">
                <AlertCircle className="w-5 h-5 text-red-600 shrink-0 mt-0.5" />
                <p className="text-sm text-red-800 font-medium">{csvError}</p>
              </div>
            )}

            <label className="block">
              <div className="relative group cursor-pointer">
                <input 
                  type="file" 
                  accept=".csv" 
                  onChange={handleFileUpload}
                  disabled={isUploading}
                  className="absolute inset-0 w-full h-full opacity-0 cursor-pointer z-10"
                />
                <div className={cn(
                  "flex items-center justify-center gap-2 text-white font-semibold py-4 px-6 rounded-2xl transition-all shadow-lg group-active:scale-95",
                  isUploading ? "bg-neutral-400" : "bg-blue-600 hover:bg-blue-700 shadow-blue-200"
                )}>
                  {isUploading ? <RefreshCw className="w-5 h-5 animate-spin" /> : <Upload className="w-5 h-5" />}
                  <span>{isUploading ? 'Subiendo...' : 'Cargar Listado CSV'}</span>
                </div>
              </div>
            </label>
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
            <button onClick={() => setSelectedEventId(null)} className="text-blue-600 font-bold text-sm">
              ← {selectedEvent.name}
            </button>
          </div>
          <div className="flex items-center gap-2">
            <button 
              onClick={() => {
                const input = document.createElement('input');
                input.type = 'file';
                input.accept = '.csv';
                input.onchange = (e: any) => handleFileUpload(e);
                input.click();
              }}
              className="flex items-center gap-2 bg-neutral-100 hover:bg-neutral-200 text-neutral-700 px-3 py-2 rounded-xl text-xs font-bold transition-all active:scale-95"
              title="Cargar nuevo CSV"
            >
              <Upload className="w-4 h-4" />
              <span>Actualizar CSV</span>
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
          <div className="bg-blue-50 rounded-lg p-1.5 text-center border border-blue-100">
            <p className="text-[8px] text-blue-600 uppercase font-bold tracking-wider mb-0">Progreso</p>
            <p className="text-base font-bold text-blue-700">{stats.percent}%</p>
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
              initial={{ opacity: 0, x: -20 }}
              animate={{ opacity: 1, x: 0 }}
              exit={{ opacity: 0, x: 20 }}
              className="flex flex-col gap-3 h-full max-h-full"
            >
              <div className="relative bg-black rounded-2xl overflow-hidden aspect-square max-w-[280px] w-full mx-auto shadow-2xl border-2 border-white shrink-0">
                <div id="reader" className="w-full h-full"></div>
                {!isScannerActive && !cameraError && (
                  <div className="absolute inset-0 flex items-center justify-center bg-neutral-900 text-white p-6 text-center">
                    <p>Iniciando cámara...</p>
                  </div>
                )}
                {cameraError && (
                  <div className="absolute inset-0 flex flex-col items-center justify-center bg-neutral-900 text-white p-8 text-center">
                    <XCircle className="w-12 h-12 text-red-500 mb-4" />
                    <p className="font-bold text-lg mb-2">Error de Cámara</p>
                    <p className="text-sm text-neutral-400 mb-6">{cameraError}</p>
                    <div className="flex flex-col gap-3 w-full">
                      <button 
                        onClick={() => setActiveTab('list')}
                        className="bg-neutral-800 text-white px-6 py-3 rounded-2xl font-bold text-sm active:scale-95 transition-all"
                      >
                        Ir a Listado
                      </button>
                      <button 
                        onClick={() => window.location.reload()}
                        className="bg-white text-black px-6 py-3 rounded-2xl font-bold text-sm active:scale-95 transition-all"
                      >
                        Recargar Aplicación
                      </button>
                    </div>
                  </div>
                )}
              </div>

              {/* Scan Result Area */}
              <div className="flex-1 flex items-center justify-center min-h-[100px]">
                <AnimatePresence mode="wait">
                  {lastScanResult ? (
                    <motion.div 
                      key="result"
                      initial={{ opacity: 0, scale: 0.9 }}
                      animate={{ opacity: 1, scale: 1 }}
                      exit={{ opacity: 0, scale: 0.9 }}
                      className={cn(
                        "w-full rounded-2xl p-4 shadow-lg border-2 flex items-center gap-3",
                        lastScanResult.success 
                          ? "bg-green-50 border-green-200 text-green-800" 
                          : "bg-red-50 border-red-200 text-red-800"
                      )}
                    >
                      <div className={cn(
                        "w-10 h-10 rounded-full flex items-center justify-center shrink-0",
                        lastScanResult.success ? "bg-green-200" : "bg-red-200"
                      )}>
                        {lastScanResult.success ? <CheckCircle2 className="w-6 h-6" /> : <XCircle className="w-6 h-6" />}
                      </div>
                      <div className="flex-1 overflow-hidden">
                        <h3 className="font-bold text-base truncate">{lastScanResult.message}</h3>
                        {lastScanResult.attendee && (
                          <p className="text-xs opacity-90 font-medium truncate">
                            {lastScanResult.attendee.Nombre} {lastScanResult.attendee.Apellidos}
                          </p>
                        )}
                      </div>
                    </motion.div>
                  ) : (
                    <motion.div
                      key="placeholder"
                      initial={{ opacity: 0 }}
                      animate={{ opacity: 1 }}
                      exit={{ opacity: 0 }}
                      className="text-center text-neutral-400"
                    >
                      <QrCode className="w-8 h-8 mx-auto mb-2 opacity-20" />
                      <p className="text-xs font-medium">Esperando escaneo...</p>
                    </motion.div>
                  )}
                </AnimatePresence>
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
                          <p className="text-xs text-neutral-500 truncate">{attendee['Tipo de entrada']}</p>
                          {attendee.validated && (
                            <span className="text-[10px] bg-green-100 text-green-700 px-1.5 py-0.5 rounded-full font-bold uppercase">
                              {attendee.validationTime}
                            </span>
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
      <nav className="fixed bottom-0 left-0 right-0 bg-white border-t border-neutral-200 px-6 py-4 z-40 shadow-[0_-4px_20px_rgba(0,0,0,0.05)]">
        <div className="max-w-md mx-auto flex items-center justify-around gap-4">
          <button 
            onClick={() => setActiveTab('scan')}
            className={cn(
              "flex flex-col items-center gap-1 flex-1 py-2 rounded-2xl transition-all",
              activeTab === 'scan' ? "text-blue-600 bg-blue-50" : "text-neutral-400 hover:text-neutral-600"
            )}
          >
            <QrCode className="w-6 h-6" />
            <span className="text-[10px] font-bold uppercase tracking-wider">Escanear</span>
          </button>
          <button 
            onClick={() => setActiveTab('list')}
            className={cn(
              "flex flex-col items-center gap-1 flex-1 py-2 rounded-2xl transition-all",
              activeTab === 'list' ? "text-blue-600 bg-blue-50" : "text-neutral-400 hover:text-neutral-600"
            )}
          >
            <Users className="w-6 h-6" />
            <span className="text-[10px] font-bold uppercase tracking-wider">Asistentes</span>
          </button>
          <button 
            onClick={() => setSelectedEventId(null)}
            className="flex flex-col items-center gap-1 flex-1 py-2 rounded-2xl transition-all text-neutral-400 hover:text-neutral-600"
          >
            <Calendar className="w-6 h-6" />
            <span className="text-[10px] font-bold uppercase tracking-wider">Eventos</span>
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
