from __future__ import annotations

import sys
from typing import Dict, Callable, List, Tuple, Optional, Any

from PyQt5.QtCore import Qt, QEvent
from PyQt5.QtWidgets import (
    QApplication,
    QHBoxLayout,
    QLabel,
    QLineEdit,
    QMainWindow,
    QMessageBox,
    QInputDialog,
    QTableWidget,
    QTableWidgetItem,
    QHeaderView,
    QPushButton,
    QTabWidget,
    QVBoxLayout,
    QGridLayout,
    QSpacerItem,
    QWidget,
    QFormLayout,
    QDoubleSpinBox,
    QTextEdit,
    QScrollArea,
    QGroupBox,
    QGraphicsDropShadowEffect,
    QFrame,
    QSizePolicy,
)
from PyQt5.QtGui import QColor, QPainter, QPixmap, QBrush, QRadialGradient, QLinearGradient, QPen

from ..config import AppSettings, ConfigManager
from ..nlu.whisper_io import AudioRecorder, WhisperTranscriber
from ..nlu.parse_intent import IntentParser
from ..nlu.multi_intent import MultiIntentExtractor
from ..nlu.answer_align import AnswerAligner
from ..services.speech import TextToSpeech
from ..services.inventory import InventoryService
from ..services.sorting_logic import SortingLogic

import logging


class MainWindow(QMainWindow):
    def __init__(self, config: ConfigManager | None = None) -> None:
        super().__init__()
        self.setWindowTitle("StorageAI")
        # -----------------------------
        # Window sizing - single source of truth
        WINDOW_MIN_W = 900
        WINDOW_MIN_H = 520
        TARGET_W_RATIO = 0.55    # initial width as % of screen width
        TARGET_H_RATIO = 0.90    # initial height as % of screen height
        MAX_H_RATIO = 0.98      # absolute max height as % of screen height

        sg = QApplication.primaryScreen().availableGeometry()
        sw, sh = sg.width(), sg.height()
        max_h = max(WINDOW_MIN_H, int(sh * MAX_H_RATIO))
        target_w = max(WINDOW_MIN_W, int(sw * TARGET_W_RATIO))
        target_h = min(max_h, int(sh * TARGET_H_RATIO))

        self.setMinimumSize(WINDOW_MIN_W, WINDOW_MIN_H)
        self.setMaximumHeight(max_h)  # single source of truth for window max height
        self.resize(target_w, target_h)

        self.config = config or ConfigManager()
        self.settings: AppSettings = self.config.load()
        self.inv = InventoryService(self.config)
        self.tts = TextToSpeech(self.config)
        self.intent = IntentParser(self.config)
        self.multi = MultiIntentExtractor(self.config)
        self.align = AnswerAligner(self.config)
        self.recorder = AudioRecorder(config=self.config)
        self.transcriber = WhisperTranscriber(self.config)
        # Core logic orchestrator
        self.logic = SortingLogic(
            self.config,
            inv=self.inv,
            tts=self.tts,
            intent=self.intent,
            multi=self.multi,
            align=self.align,
            recorder=self.recorder,
            transcriber=self.transcriber,
        )
        # Cache for responsive grid of box groups
        self._box_groups: list[QGroupBox] = []
        self._boxes_cols: int = 0

        self.tabs = QTabWidget()
        self.tabs.addTab(self._build_inventory_tab(), "Inventory")
        self.tabs.addTab(self._build_api_keys_tab(), "API Keys")

        container = QWidget()
        vbox = QVBoxLayout(container)
        # Add tabs first; mic row will sit underneath the tabs
        vbox.addWidget(self.tabs)
        self.setCentralWidget(container)
        # Apply global theme
        self._apply_theme()

        # Mic lives inside Inventory tab (under the tab bar)

        # Voice transcript + step log
        said_row = QHBoxLayout()
        said_row.addWidget(QLabel("You said:"))
        self.txt_transcript = QLineEdit()
        self.txt_transcript.setReadOnly(True)
        said_row.addWidget(self.txt_transcript)
        vbox.addLayout(said_row)

        self.voice_log = QTextEdit()
        self.voice_log.setReadOnly(True)
        try:
            self.voice_log.setSizePolicy(QSizePolicy.Expanding, QSizePolicy.Fixed)
            self.voice_log.setMaximumHeight(160)  # make terminal shorter
        except Exception:
            pass
        vbox.addWidget(self.voice_log)

    def _apply_theme(self) -> None:
        try:
            # Futuristic dark theme with higher contrast and soft gradients
            self.setStyleSheet(
                "QMainWindow { background: qradialgradient(cx:0.5, cy:0.18, radius:0.70, fx:0.5, fy:0.18,\n"
                " stop:0 rgba(255,255,255,0.04), stop:0.35 rgba(8,8,10,0.98), stop:1 #0A0A0A); }\n"
                "QTabWidget::pane { border: 1px solid rgba(255,255,255,0.08); background: transparent; }\n"
                "QTabBar::tab { background: transparent; color: #D0D0D0; padding: 8px 14px; }\n"
                "QTabBar::tab:selected { color: #FFFFFF; border-bottom: 2px solid #FF4D4D; }\n"
                "QLabel { color: #FFFFFF; }\n"
                "QLineEdit, QDoubleSpinBox { background-color: #0D0D0F; color: #F5F5F5; border: 1px solid rgba(255,255,255,0.18); padding: 6px 8px; border-radius: 8px; }\n"
                "QPushButton { background-color: #121212; color: #F0F0F0; border: 1px solid rgba(255,77,77,0.35); padding: 8px 14px; border-radius: 10px; }\n"
                "QPushButton:hover { background-color: #1A1A1A; border-color: rgba(255,77,77,0.55); }\n"
                "QPushButton:disabled { color: #6B7280; border-color: rgba(255,255,255,0.08); }\n"
                "QTextEdit { background-color: #0D0D0F; color: #F0F0F0; border: 1px solid rgba(255,255,255,0.12); border-radius: 8px; }"\
            )
        except Exception:
            pass

    # -------------------------
    # Tabs
    # -------------------------
    def _build_api_keys_tab(self) -> QWidget:
        tab = QWidget()
        form = QFormLayout(tab)

        # Field definitions: {label: (attr_name, is_secret)}
        fields: Dict[str, tuple[str, bool]] = {
            "OpenAI API Key": ("openai_api_key", True),
            "Pinecone API Key": ("pinecone_api_key", True),
            "Pinecone Host URL": ("pinecone_host", False),
            "Airtable Personal Access Token": ("airtable_token", True),
            "Airtable Base ID": ("airtable_base_id", False),
            "Airtable Boxes Table": ("airtable_boxes_table", False),
            "Airtable Items Table": ("airtable_items_table", False),
            "Airtable Items Link Field": ("airtable_items_link_field", False),
            "Airtable Boxes Title Field": ("airtable_boxes_name_field", False),
            "Airtable Items Title Field": ("airtable_items_name_field", False),
            "Airtable Items Quantity Field": ("airtable_items_quantity_field", False),
            "OpenAI Chat Model": ("openai_chat_model", False),
            "OpenAI Whisper Model": ("openai_whisper_model", False),
            "OpenAI TTS Voice": ("openai_tts_voice", False),
            "OpenAI TTS Model": ("openai_tts_model", False),
        }

        self._api_inputs: Dict[str, QWidget] = {}
        for label, (attr, secret) in fields.items():
            # Special handling for numeric sensitivity
            if attr == "wakeword_sensitivity":
                spin = QDoubleSpinBox()
                spin.setRange(0.0, 1.0)
                spin.setSingleStep(0.05)
                try:
                    spin.setValue(float(getattr(self.settings, attr, 0.5)))
                except Exception:
                    spin.setValue(0.5)
                self._api_inputs[attr] = spin
                form.addRow(QLabel(label), spin)
                continue

            edit = QLineEdit()
            value = getattr(self.settings, attr, "")
            edit.setText(str(value) if value is not None else "")
            if secret:
                edit.setEchoMode(QLineEdit.Password)
            edit.setPlaceholderText(attr)
            self._api_inputs[attr] = edit
            form.addRow(QLabel(label), edit)

        save_btn = QPushButton("Save Settings")
        save_btn.clicked.connect(self._on_save_settings)
        form.addRow(QWidget(), save_btn)

        return tab

    def _build_inventory_tab(self) -> QWidget:
        tab = QWidget()
        vbox = QVBoxLayout(tab)

        # Header (title + counts)
        header = QHBoxLayout()
        self.lbl_header = QLabel("Inventory")
        self.lbl_header.setStyleSheet("QLabel { font-size: 20px; font-weight: 600; color: #E0E6F0; }")
        self.lbl_sub = QLabel("")
        self.lbl_sub.setStyleSheet("QLabel { color: #9FB3C8; }")
        header.addWidget(self.lbl_header)
        header.addSpacing(12)
        header.addWidget(self.lbl_sub)
        header.addStretch(1)
        vbox.addLayout(header)

        # Mic row (under the tabs, above boxes)
        voice_row = QHBoxLayout()
        self.btn_voice_cmd = QPushButton("")
        self.btn_voice_cmd.setCheckable(True)
        self.btn_voice_cmd.setFixedSize(120, 120)
        self._set_mic_state("idle")
        self.btn_voice_cmd.setToolTip("Start/stop voice command")
        # Custom HAL-style paint
        try:
            self.btn_voice_cmd.setStyleSheet("QPushButton { border: none; background: transparent; }")
        except Exception:
            pass
        self.btn_voice_cmd.paintEvent = self._paint_hal_mic  # type: ignore[attr-defined]
        voice_row.addStretch(1)
        voice_row.addWidget(self.btn_voice_cmd)
        voice_row.addStretch(1)
        vbox.addLayout(voice_row)
        self.btn_voice_cmd.clicked.connect(self._on_voice_command)

        # Boxes view (scrollable list of boxes, each with its items)
        self.boxes_area = QScrollArea()
        self.boxes_area.setWidgetResizable(True)
        self.boxes_area.setVerticalScrollBarPolicy(Qt.ScrollBarAsNeeded)
        self.boxes_area.setHorizontalScrollBarPolicy(Qt.ScrollBarAlwaysOff)
        # Remove grey padding/background around boxes (transparent viewport & no frame)
        self.boxes_area.setFrameShape(QFrame.NoFrame)
        self.boxes_area.setStyleSheet("QScrollArea { background: transparent; border: none; }")
        self.boxes_container = QWidget()
        self.boxes_container.setObjectName("boxes_container")
        self.boxes_container.setStyleSheet("#boxes_container { background: transparent; }")
        self.boxes_layout = QGridLayout(self.boxes_container)
        # Equalize horizontal edge padding with gutters so rows span end-to-end
        self.boxes_layout.setContentsMargins(20, 8, 20, 8)
        self.boxes_layout.setHorizontalSpacing(20)
        self.boxes_layout.setVerticalSpacing(20)
        try:
            # Ensure two columns share available width evenly
            self.boxes_layout.setColumnStretch(0, 1)
            self.boxes_layout.setColumnStretch(1, 1)
        except Exception:
            pass
        self.boxes_area.setWidget(self.boxes_container)
        self.boxes_area.setSizePolicy(QSizePolicy.Expanding, QSizePolicy.Expanding)
        vbox.addWidget(self.boxes_area, stretch=1)

        # Toolbar actions - build buttons once
        self.btn_add = QPushButton("Add item")
        self.btn_remove = QPushButton("Remove item")
        self.btn_find = QPushButton("Search")
        self.btn_add_box = QPushButton("Add box")
        self.btn_sync = QPushButton("Sync")
        self.btn_add.setStyleSheet(
            "QPushButton { background-color: #FFFFFF; color: #000000; border: 1px solid #D1D5DB; padding: 8px 14px; border-radius: 8px; } "
            "QPushButton:hover { background-color: #F3F4F6; } "
            "QPushButton:pressed { background-color: #E5E7EB; }"
        )
        try:
            for b in (self.btn_add, self.btn_remove, self.btn_find, self.btn_add_box, self.btn_sync):
                b.setSizePolicy(QSizePolicy.Fixed, QSizePolicy.Fixed)
                b.setMinimumWidth(160)
        except Exception:
            pass

        # Two-row toolbar (top)
        self.toolbar_top = QWidget()
        row1 = QHBoxLayout(self.toolbar_top)
        row1.setSpacing(0)
        row1.setContentsMargins(20, 0, 20, 0)
        row1.addStretch(1)
        self.row1_inner = QWidget()
        self.row1_inner.setSizePolicy(QSizePolicy.Fixed, QSizePolicy.Preferred)
        self.row1_inner_layout = QHBoxLayout(self.row1_inner)
        self.row1_inner_layout.setContentsMargins(0, 0, 0, 0)
        self.row1_inner_layout.setSpacing(20)
        self.row1_inner_layout.addWidget(self.btn_add)
        self.row1_inner_layout.addWidget(self.btn_remove)
        row1.addWidget(self.row1_inner)
        row1.addStretch(1)
        vbox.addWidget(self.toolbar_top)

        # Two-row toolbar (bottom)
        self.toolbar_bottom = QWidget()
        row2 = QHBoxLayout(self.toolbar_bottom)
        row2.setSpacing(0)
        row2.setContentsMargins(20, 0, 20, 0)
        row2.addStretch(1)
        self.row2_inner = QWidget()
        self.row2_inner.setSizePolicy(QSizePolicy.Fixed, QSizePolicy.Preferred)
        self.row2_inner_layout = QHBoxLayout(self.row2_inner)
        self.row2_inner_layout.setContentsMargins(0, 0, 0, 0)
        self.row2_inner_layout.setSpacing(20)
        self.row2_inner_layout.addWidget(self.btn_find)
        self.row2_inner_layout.addWidget(self.btn_add_box)
        self.row2_inner_layout.addWidget(self.btn_sync)
        row2.addWidget(self.row2_inner)
        row2.addStretch(1)
        vbox.addWidget(self.toolbar_bottom)

        # Single-row toolbar (hidden initially)
        self.toolbar_single = QWidget()
        self.toolbar_single.setVisible(False)
        row_single = QHBoxLayout(self.toolbar_single)
        row_single.setSpacing(0)
        row_single.setContentsMargins(20, 0, 20, 0)
        row_single.addStretch(1)
        self.row_single_inner = QWidget()
        self.row_single_inner.setSizePolicy(QSizePolicy.Fixed, QSizePolicy.Preferred)
        self.row_single_layout = QHBoxLayout(self.row_single_inner)
        self.row_single_layout.setContentsMargins(0, 0, 0, 0)
        self.row_single_layout.setSpacing(20)
        row_single.addWidget(self.row_single_inner)
        row_single.addStretch(1)
        vbox.addWidget(self.toolbar_single)

        # Wire to basic dialogs; services wired in future voice loop
        self.btn_add.clicked.connect(self._on_add_item)
        self.btn_remove.clicked.connect(self._on_remove_item)
        self.btn_find.clicked.connect(self._on_find_item)
        self.btn_add_box.clicked.connect(self._on_add_box)
        self.btn_sync.clicked.connect(self._on_sync_airtable)

        # Tighten spacing so buttons sit just above logs
        # initial mirror
        # Keep a reference to layout and boxes area index for stretch adjustments
        self._inventory_vbox = vbox
        try:
            self._boxes_area_index = vbox.indexOf(self.boxes_area)
        except Exception:
            self._boxes_area_index = -1
        self._toolbar_mode = "two"
        self._mirror_airtable_to_boxes()
        self._reflow_toolbar()
        return tab

    # -------------------------
    # Handlers
    # -------------------------
    def _on_save_settings(self) -> None:
        # Gather values
        for attr, widget in self._api_inputs.items():
            if isinstance(widget, QDoubleSpinBox):
                setattr(self.settings, attr, float(widget.value()))
            elif isinstance(widget, QLineEdit):
                setattr(self.settings, attr, widget.text().strip())
            else:
                # Fallback for unexpected widget types
                try:
                    text = getattr(widget, "text", lambda: "")()
                except Exception:
                    text = ""
                setattr(self.settings, attr, text)

        try:
            self.config.save(self.settings)
        except Exception as exc:
            QMessageBox.critical(self, "Save Failed", f"Could not save settings: {exc}")
            return

        QMessageBox.information(self, "Saved", "Settings saved to api_keys.json at project root.")

    def _not_implemented(self, action: str) -> None:
        QMessageBox.information(self, action, f"'{action}' will be available in a future step.")

    # Inventory handlers
    def _on_add_item(self) -> None:
        if not self.logic:
            self._critical_message("Initialization Error", "Logic service not initialized.")
            return

        # UI: Get item and box name and quantity from user
        box_names = []
        try:
            # Direct call to inv.store for UI-only box listing
            boxes = self.inv.store.list_boxes()
            box_names = [b.name for b in boxes]
        except Exception as exc:
            logging.getLogger("UI").exception("List boxes failed")
            self._critical_message("Boxes Error", str(exc))
            return

        if not box_names:
            self._info_message("No Boxes", "Create a box before adding items.")
            return

        box_name, ok = QInputDialog.getItem(self, "Select Box", "Box:", box_names, 0, False)
        if not ok or not box_name:
            return

        name, ok = QInputDialog.getText(self, "Add Item", "Item name:")
        if not ok or not name.strip():
            return

        qty, ok = QInputDialog.getInt(self, "Add Item", "Quantity:", value=1, min=1, max=100000)
        if not ok:
            return

        # Delegate logic to SortingLogic
        self.logic.handle_add_item_action(
            name.strip(), qty, box_name.strip(),
            critical_message=self._critical_message,
            info_message=self._info_message,
            mirror_airtable_to_boxes=self._mirror_airtable_to_boxes,
        )

    def _on_remove_item(self) -> None:
        if not self.logic:
            self._critical_message("Initialization Error", "Logic service not initialized.")
            return

        name, ok = QInputDialog.getText(self, "Remove Item", "Item name:")
        if not ok or not name.strip():
            return

        qty, ok = QInputDialog.getInt(self, "Remove Item", "Quantity:", value=1, min=1, max=100000)
        if not ok:
            return

        self.logic.handle_remove_item_action(
            name.strip(), qty,
            critical_message=self._critical_message,
            info_message=self._info_message,
            mirror_airtable_to_boxes=self._mirror_airtable_to_boxes,
        )

    def _on_find_item(self) -> None:
        if not self.logic:
            self._critical_message("Initialization Error", "Logic service not initialized.")
            return

        name, ok = QInputDialog.getText(self, "Find Item", "Item name:")
        if not ok or not name.strip():
            return

        self.logic.handle_find_item_action(
            name.strip(),
            critical_message=self._critical_message,
            info_message=self._info_message,
        )

    def _on_add_box(self) -> None:
        if not self.logic:
            self._critical_message("Initialization Error", "Logic service not initialized.")
            return

        box, ok = QInputDialog.getText(self, "Add Box", "Box name:")
        if not ok or not box.strip():
            return

        self.logic.handle_add_box_action(
            box.strip(),
            critical_message=self._critical_message,
            info_message=self._info_message,
            mirror_airtable_to_boxes=self._mirror_airtable_to_boxes,
        )

    def _on_sync_airtable(self) -> None:
        if not self.logic:
            self._critical_message("Initialization Error", "Logic service not initialized.")
            return

        self.logic.handle_sync_airtable_action(
            critical_message=self._critical_message,
            mirror_airtable_to_boxes=self._mirror_airtable_to_boxes,
        )

    # -------------------------
    # Voice Command (manual)
    # -------------------------
    def _on_voice_command(self) -> None:
        # Toggle behavior: first click starts recording; second click stops and processes
        if not self.btn_voice_cmd.isChecked():
            # Button toggled off -> stop and process
            # Immediately show processing (blue) before any heavy work
            self._set_mic_state("processing")
            # Force an immediate repaint of the mic button so blue shows right away
            try:
                self.btn_voice_cmd.repaint()
                QApplication.processEvents()
            except Exception:
                pass
                QApplication.processEvents()
            wav = self.recorder.stop_and_get_wav()
            self._log_step("Audio", f"Captured {len(wav)} bytes of audio")
            try:
                text = self.transcriber.transcribe(wav)
                self.txt_transcript.setText(text)
                self._log_step("Transcription", text or "<empty>")
                if not (text or "").strip():
                    self._log_step("Result", "No speech detected")
                    self.tts.speak("I didn't catch that.")
                else:
                    self._handle_voice_intent(text)
            except Exception as exc:
                logging.getLogger("UI").exception("Voice command failed")
                self._critical_message("Voice Command Failed", str(exc))
            finally:
                self._set_voice_active(False)

        # Button toggled on -> start capture
        else:  # self.btn_voice_cmd.isChecked() is True
            # Immediately show recording (green)
            self._set_voice_active(True)
            QApplication.processEvents()
            self._clear_voice_log()
            self._log_step("Start", "Voice command recording... press the button again to stop")
            try:
                self.recorder.start_stream()
            except Exception as exc:
                logging.getLogger("UI").exception("Voice start failed")
                self._critical_message("Voice Start Failed", str(exc))
                self._set_voice_active(False)

    def _set_voice_active(self, active: bool) -> None:
        try:
            self.btn_voice_cmd.setChecked(active)
            # Keep button enabled so user can stop by clicking again
            self.btn_voice_cmd.setEnabled(True)
            # Visual mic state
            self._set_mic_state("recording" if active else "idle")
        except Exception:
            pass

    def _handle_voice_intent(self, text: str, op_to_process: Optional[Dict[str, Any]] = None) -> None:
        if not self.logic:
            self._critical_message("Initialization Error", "Logic service not initialized.")
            return

        if op_to_process:
            # If an operation was passed directly (e.g., from a suggestion selection),
            # skip parsing and directly process the single operation.
            self._log_step("Processing Suggested Item", f"Processing: {self._format_op_pretty(op_to_process)}")
            ok, spoken, _, _ = self.logic._process_ops_batch(
                [op_to_process],
                set_mic_state=self._set_mic_state,
                log_step=self._log_step,
                critical_message=self._critical_message,
                info_message=self._info_message,
                mirror_airtable_to_boxes=self._mirror_airtable_to_boxes,
            )
            if spoken:
                self._set_mic_state("processing")
                QApplication.processEvents()
                self.tts.speak(spoken)
            self._set_mic_state("idle")
            self._mirror_airtable_to_boxes()
            return

        # Original flow: parse text if no pre-processed operation was provided
        result_op = self.logic.handle_voice_intent(
            text,
            set_mic_state=self._set_mic_state,
            log_step=self._log_step,
            format_op_pretty=self._format_op_pretty,
            critical_message=self._critical_message,
            info_message=self._info_message,
            mirror_airtable_to_boxes=self._mirror_airtable_to_boxes,
        )
        if result_op is not None and isinstance(result_op, dict):
            # If a suggestion was selected and returned as a full op dictionary,
            # re-call _handle_voice_intent with this pre-processed operation.
            self._log_step("Suggestion selected", f"Re-triggering with: {self._format_op_pretty(result_op)}")
            self._handle_voice_intent(text, op_to_process=result_op) # Pass original text for logging context, new op for processing

    def _critical_message(self, title: str, message: str) -> None:
        QMessageBox.critical(self, title, message)

    def _info_message(self, title: str, message: str) -> None:
        QMessageBox.information(self, title, message)

    # Logic moved to SortingLogic

    def _format_op_pretty(self, op: dict) -> str:
        try:
            intent = (op.get("intent") or "").upper()
            if intent == "ADD":
                name = op.get("object_name") or "?"
                qty = op.get("quantity") or "1"
                dst = op.get("to_box") or op.get("box_name") or "?"
                return f"ADD {qty} '{name}' to box {dst}"
            if intent == "REMOVE":
                name = op.get("object_name") or "?"
                qty = op.get("quantity") or "1"
                return f"REMOVE {qty} from '{name}'"
            if intent == "MOVE":
                name = op.get("object_name") or "?"
                dst = op.get("to_box") or "?"
                src = op.get("from_box") or None
                if src:
                    return f"MOVE '{name}' from box {src} to box {dst}"
                return f"MOVE '{name}' to box {dst}"
            if intent == "FIND":
                name = op.get("object_name") or "?"
                return f"FIND '{name}'"
            if intent == "CLEAR_BOX":
                dst = op.get("to_box") or op.get("box_name") or "?"
                return f"CLEAR contents of box {dst}"
            return str(op)
        except Exception:
            return str(op)


    def _clear_voice_log(self) -> None:
        try:
            self.voice_log.clear()
        except Exception:
            pass

    def _log_step(self, title: str, detail: str) -> None:
        try:
            self.voice_log.append(f"[{title}] {detail}")
        except Exception:
            pass

    def _set_mic_state(self, state: str) -> None:
        """Update the mic button styling by state: idle(red), recording(green), processing(blue)."""
        try:
            self._mic_visual_state = state
            # Use repaint to avoid queued updates getting delayed by heavy work
            try:
                self.btn_voice_cmd.repaint()
            except Exception:
                self.btn_voice_cmd.update()
        except Exception:
            pass

    def _apply_glow(self, widget: QWidget, color: QColor, radius: int = 25) -> None:
        try:
            effect = QGraphicsDropShadowEffect(widget)
            effect.setBlurRadius(radius)
            effect.setColor(color)
            effect.setOffset(0, 0)
            widget.setGraphicsEffect(effect)
        except Exception:
            pass

    def _paint_hal_mic(self, event):  # custom paint for HAL-style mic button
        try:
            size = min(self.btn_voice_cmd.width(), self.btn_voice_cmd.height())
            cx = self.btn_voice_cmd.width() // 2
            cy = self.btn_voice_cmd.height() // 2
            r_outer = int(size * 0.48)
            r_inner = int(size * 0.40)
            r_core = int(size * 0.30)
            painter = QPainter(self.btn_voice_cmd)
            painter.setRenderHints(QPainter.Antialiasing | QPainter.SmoothPixmapTransform)

            # Background clear
            painter.fillRect(self.btn_voice_cmd.rect(), Qt.transparent)

            # Outer metallic ring
            ring_grad = QLinearGradient(0, 0, 0, self.btn_voice_cmd.height())
            ring_grad.setColorAt(0.0, QColor(220, 230, 240, 220))
            ring_grad.setColorAt(0.5, QColor(180, 190, 200, 255))
            ring_grad.setColorAt(1.0, QColor(220, 230, 240, 220))
            painter.setBrush(QBrush(ring_grad))
            painter.setPen(QPen(QColor(40, 50, 70, 220), 2))
            painter.drawEllipse(cx - r_outer, cy - r_outer, r_outer * 2, r_outer * 2)

            # Inner glass dome with neutral black radial (no red undertone)
            glass_grad = QRadialGradient(cx, cy - int(r_inner * 0.15), r_inner)
            glass_grad.setColorAt(0.0, QColor(24, 24, 24))
            glass_grad.setColorAt(0.6, QColor(12, 12, 12))
            glass_grad.setColorAt(1.0, QColor(5, 5, 5))
            painter.setBrush(QBrush(glass_grad))
            painter.setPen(QPen(QColor(30, 45, 70), 1))
            painter.drawEllipse(cx - r_inner, cy - r_inner, r_inner * 2, r_inner * 2)

            # Core lens color varies by state: idle=red, recording=green, processing=white
            state = getattr(self, "_mic_visual_state", "idle")
            if state == "processing":  # white
                core_center = QColor(255, 255, 255)
                core_mid = QColor(230, 230, 230)
                glow_color = QColor(255, 255, 255, 100)
            elif state == "recording":  # green
                core_center = QColor(120, 255, 160)
                core_mid = QColor(30, 180, 110)
                glow_color = QColor(80, 255, 160, 90)
            else:  # idle red
                core_center = QColor(255, 140, 100)
                core_mid = QColor(200, 40, 30)
                glow_color = QColor(255, 90, 90, 90)
            core_grad = QRadialGradient(cx, cy, r_core)
            core_grad.setColorAt(0.0, core_center)
            core_grad.setColorAt(0.5, core_mid)
            # darker edge in state hue (no red bleed)
            if state == "processing":
                core_edge = QColor(28, 28, 28)
            elif state == "recording":
                core_edge = QColor(8, 60, 32)
            else:
                core_edge = QColor(60, 8, 8)
            core_grad.setColorAt(1.0, core_edge)
            painter.setBrush(QBrush(core_grad))
            painter.setPen(Qt.NoPen)
            painter.drawEllipse(cx - r_core, cy - r_core, r_core * 2, r_core * 2)

            # Internal reflections/arcs
            painter.setPen(QPen(QColor(255, 255, 255, 28), 4))
            for k in (0.25, 0.50, 0.75):
                rr = int(r_core * k)
                painter.drawArc(cx - rr, cy - rr - int(r_core * 0.25), rr * 2, rr * 2, 30 * 16, 120 * 16)

            # Subtle outer glow matching state accent
            glow = QRadialGradient(cx, cy, r_outer * 1.2)
            glow.setColorAt(0.0, glow_color)
            glow.setColorAt(1.0, QColor(0, 0, 0, 0))
            painter.setBrush(QBrush(glow))
            painter.setPen(Qt.NoPen)
            painter.drawEllipse(cx - r_outer, cy - r_outer, r_outer * 2, r_outer * 2)

            painter.end()
        except Exception:
            pass


    def _mirror_airtable_to_table(self) -> None:
        """Legacy compatibility: delegate to grid refresh to avoid crashes when table is absent."""
        try:
            self._mirror_airtable_to_boxes()
        except Exception as exc:
            logging.getLogger("UI").exception("Mirror (legacy->grid) failed")
            self._critical_message("Airtable", f"Could not refresh view: {exc}")

    def _populate_table(self, items, box_id_to_name):
        """Legacy helper kept for backward compatibility; now updates grid."""
        # Prefer updating the visible boxes grid
        try:
            self._mirror_airtable_to_boxes()
            return
        except Exception:
            pass
        # If a QTableWidget named `table` exists, update it (older UI versions)
        try:
            if hasattr(self, "table") and isinstance(self.table, QTableWidget):
                self.table.setRowCount(len(items))
                for row, it in enumerate(items):
                    self.table.setItem(row, 0, QTableWidgetItem(it.name))
                    self.table.setItem(row, 1, QTableWidgetItem(it.canonical_name))
                    self.table.setItem(row, 2, QTableWidgetItem(str(it.quantity)))
                    box_name = box_id_to_name.get(it.box_id, it.box_id)
                    self.table.setItem(row, 3, QTableWidgetItem(box_name))
        except Exception:
            pass

    def _mirror_airtable_to_boxes(self) -> None:
        try:
            inv = InventoryService(self.config)
            boxes = sorted(inv.store.list_boxes(), key=lambda b: b.name.strip().lower())
            items = inv.store.list_items()
            box_id_to_name = {b.id: b.name for b in boxes}
            # Update header counts
            try:
                total_items = len(items)
                self.lbl_sub.setText(f"• {len(boxes)} boxes • {total_items} different items")
            except Exception:
                pass
            # Clear previously created groups and layout placements
            try:
                for g in self._box_groups:
                    g.setParent(None)
                    try:
                        g.deleteLater()
                    except Exception:
                        pass
            except Exception:
                pass
            self._box_groups = []
            while self.boxes_layout.count():
                _ = self.boxes_layout.takeAt(0)
            # Build a group for each box (even if empty)
            name_to_items = {}
            for it in items:
                name = box_id_to_name.get(it.box_id, it.box_id)
                name_to_items.setdefault(name, []).append(it)
            for idx, box in enumerate(boxes):
                group = QGroupBox(f"Box {box.name}")
                # Fill available column width evenly
                try:
                    group.setSizePolicy(QSizePolicy.Expanding, QSizePolicy.Preferred)
                except Exception:
                    pass
                group.setStyleSheet(
                    "QGroupBox { font-weight: 600; font-size: 16px; color: #FFFFFF; border: 1px solid rgba(255,255,255,0.14);"
                    " border-radius: 12px; margin-top: 28px; padding-top: 24px;"
                    " background-color: qlineargradient(x1:0, y1:0, x2:0, y2:1, stop:0 #0E0E0E, stop:1 #141414); }"
                    "QGroupBox::title { subcontrol-origin: padding; subcontrol-position: top left; left: 18px; top: 6px; padding: 4px 10px;"
                    " color: #FFFFFF; background: transparent; }"
                )
                inner = QWidget()
                inner_layout = QVBoxLayout(inner)
                inner_layout.setContentsMargins(8, 8, 8, 8)
                # Items list for this box
                table = QTableWidget()
                table.setColumnCount(2)
                table.setHorizontalHeaderLabels(["item", "qty"])
                table.setStyleSheet(
                    "QTableWidget { background: transparent; color: #FFFFFF; border: 1px solid rgba(255,255,255,0.12); border-radius: 8px; }"
                    "QHeaderView::section { background-color: #101010; color: #FFFFFF; border: none; padding: 10px 12px; }"
                    "QTableWidget::item { background: transparent; padding: 6px 10px; }"
                )
                table.setShowGrid(False)
                table.setFrameShape(QFrame.NoFrame)
                try:
                    header = table.horizontalHeader()
                    header.setStretchLastSection(False)
                    header.setSectionResizeMode(0, QHeaderView.Stretch)
                    header.setSectionResizeMode(1, QHeaderView.Stretch)
                    # Use relative stretch factors: item ~80%, qty ~20%
                    header.resizeSection(0, 80)
                    header.resizeSection(1, 20)
                    # For some Qt versions, stretch factors via resizeSection are hints; ensure min widths
                    table.setColumnWidth(0, int(table.width() * 0.8))
                    table.setColumnWidth(1, int(table.width() * 0.2))
                    table.verticalHeader().setVisible(False)
                except Exception:
                    pass
                # Constrain height so inner lists scroll rather than expanding infinitely
                table.setMinimumHeight(140)
                table.setMaximumHeight(240)
                table.setVerticalScrollMode(QTableWidget.ScrollPerPixel)
                table.setHorizontalScrollBarPolicy(Qt.ScrollBarAlwaysOff)
                box_items = name_to_items.get(box.name, [])
                table.setRowCount(len(box_items))
                for r, it in enumerate(box_items):
                    table.setItem(r, 0, QTableWidgetItem(it.name))
                    table.setItem(r, 1, QTableWidgetItem(str(it.quantity)))
                inner_layout.addWidget(table)
                # Keep columns at ~80/20 when the table resizes
                try:
                    def _resize_columns(tbl=table):
                        try:
                            w = max(1, tbl.viewport().width())
                            tbl.setColumnWidth(0, int(w * 0.80))
                            tbl.setColumnWidth(1, int(w * 0.20))
                        except Exception:
                            pass
                    table.viewport().installEventFilter(self)
                    _resize_columns()
                except Exception:
                    pass
                group_layout = QVBoxLayout(group)
                group_layout.addWidget(inner)
                # Defer placement to responsive reflow
                self._box_groups.append(group)
                # Soft white glow around each box group
                self._apply_glow(group, QColor(255, 255, 255, 220), 30)
            # Position groups according to current viewport width
            self._reflow_boxes_grid()
        except Exception as exc:
            logging.getLogger("UI").exception("Mirror load failed")
            self._critical_message("Airtable", f"Could not load Airtable: {exc}")

    def _compute_box_columns(self) -> int:
        """Compute number of columns (1–4) using fixed breakpoints for consistent wrap.

        Breakpoints (approx, including margins/gutters):
        - < 500px: 1 column
        - 500–899px: 2 columns
        - 900–1299px: 3 columns
        - >= 1300px: 4 columns
        """
        try:
            available = self.boxes_area.viewport().width()
        except Exception:
            available = self.width()
        if available < 500:
            return 1
        if available < 900:
            return 2
        if available < 1300:
            return 3
        return 4

    def _reflow_boxes_grid(self) -> None:
        """Reposition cached box groups into a responsive grid without refetching."""
        try:
            if not self._box_groups:
                return
            cols = self._compute_box_columns()
            # Avoid redundant work on continuous resize if nothing changes
            if cols == self._boxes_cols and self.boxes_layout.count() == len(self._box_groups):
                return
            # Clear placements
            while self.boxes_layout.count():
                _ = self.boxes_layout.takeAt(0)
            # Reset all known columns to zero stretch so downsizing doesn't leave empty columns
            for c in range(0, 8):
                try:
                    self.boxes_layout.setColumnStretch(c, 0)
                    self.boxes_layout.setColumnMinimumWidth(c, 0)
                except Exception:
                    pass
            # Activate stretch for current columns
            for c in range(cols):
                try:
                    self.boxes_layout.setColumnStretch(c, 1)
                except Exception:
                    pass
            total = len(self._box_groups)
            if cols <= 1 or total <= cols:
                # Single column or only one row -> simple placement
                for idx, group in enumerate(self._box_groups):
                    row = idx // cols if cols > 0 else 0
                    col = idx % cols if cols > 0 else 0
                    self.boxes_layout.addWidget(group, row, col)
            else:
                # Place complete rows normally
                full_rows = total // cols
                remainder = total % cols
                upto = full_rows * cols
                for idx in range(upto):
                    group = self._box_groups[idx]
                    row = idx // cols
                    col = idx % cols
                    self.boxes_layout.addWidget(group, row, col)
                # Last row: place remaining widgets left-aligned; leave empty cells blank so sizes stay uniform
                if remainder:
                    last_row = full_rows
                    for j in range(remainder):
                        group = self._box_groups[upto + j]
                        self.boxes_layout.addWidget(group, last_row, j)
                    # Add invisible spacers in remaining columns to preserve equal cell widths across the row
                    for j in range(remainder, cols):
                        try:
                            spacer = QWidget()
                            spacer.setSizePolicy(QSizePolicy.Expanding, QSizePolicy.Preferred)
                            spacer.setVisible(False)
                            self.boxes_layout.addWidget(spacer, last_row, j)
                        except Exception:
                            pass
            self._boxes_cols = cols
        except Exception:
            pass

    def _reflow_toolbar(self) -> None:
        """Switch toolbar between two rows and one row when width fits five buttons.

        We approximate fit using button min widths plus fixed gaps and side padding.
        """
        try:
            available = self.width()
            side_padding = 40  # 20 left + 20 right
            gap = 20
            try:
                btn_w = max(
                    self.btn_add.minimumWidth(),
                    self.btn_remove.minimumWidth(),
                    self.btn_find.minimumWidth(),
                    self.btn_add_box.minimumWidth(),
                    self.btn_sync.minimumWidth(),
                )
            except Exception:
                btn_w = 160
            needed = side_padding + (btn_w * 5) + (gap * 4)
            single = available >= needed

            # Toggle visibility
            if single and self._toolbar_mode != "one":
                # Move buttons into single-row container
                self._clear_layout(self.row_single_layout)
                for b in (self.btn_add, self.btn_remove, self.btn_find, self.btn_add_box, self.btn_sync):
                    self.row_single_layout.addWidget(b)
                self.toolbar_top.setVisible(False)
                self.toolbar_bottom.setVisible(False)
                self.toolbar_single.setVisible(True)
                self._toolbar_mode = "one"
                # Let boxes area take more vertical space by reducing toolbar footprint
                try:
                    self.boxes_area.setMinimumHeight(self.boxes_area.minimumHeight() + 40)
                except Exception:
                    pass
            elif (not single) and self._toolbar_mode != "two":
                # Restore two-row layout
                self._clear_layout(self.row1_inner_layout)
                self._clear_layout(self.row2_inner_layout)
                for b in (self.btn_add, self.btn_remove):
                    self.row1_inner_layout.addWidget(b)
                for b in (self.btn_find, self.btn_add_box, self.btn_sync):
                    self.row2_inner_layout.addWidget(b)
                self.toolbar_single.setVisible(False)
                self.toolbar_top.setVisible(True)
                self.toolbar_bottom.setVisible(True)
                self._toolbar_mode = "two"
            # else no change
        except Exception:
            pass

    def _clear_layout(self, layout) -> None:
        try:
            while layout.count():
                item = layout.takeAt(0)
                w = item.widget()
                if w is not None:
                    w.setParent(None)
        except Exception:
            pass

    def resizeEvent(self, event):  # type: ignore[override]
        try:
            super().resizeEvent(event)
        except Exception:
            pass
        try:
            self._reflow_boxes_grid()
        except Exception:
            pass
        try:
            self._reflow_toolbar()
        except Exception:
            pass

    def eventFilter(self, obj, event):  # keep table columns at ~80/20 on viewport resize
        try:
            if event.type() == QEvent.Resize and isinstance(obj, QWidget) and isinstance(obj.parent(), QTableWidget):
                tbl = obj.parent()
                w = max(1, obj.width())
                tbl.setColumnWidth(0, int(w * 0.80))
                tbl.setColumnWidth(1, int(w * 0.20))
        except Exception:
            pass
        return super().eventFilter(obj, event)


def launch_app() -> None:
    app = QApplication(sys.argv)
    window = MainWindow()
    window.show()
    sys.exit(app.exec_())


__all__ = ["MainWindow", "launch_app"]

