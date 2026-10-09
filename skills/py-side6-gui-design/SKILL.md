---
name: py-side6-gui-design
description: Design principles for Python desktop applications built with PySide6/PyQt. Universal patterns for widget design, layout architecture, accessibility, micro-interactions, and performance. Use this skill when designing any desktop GUI — whether a media player, editor, IDE, tool, or admin panel. Triggers on tasks involving PySide6/PyQt UI design, desktop app UX, widget styling, layout architecture, QSS theming, or Python desktop application interface improvements.
Framework-agnostic within the Python desktop ecosystem.
---
# Python Desktop GUI Design

Design principles for Python desktop applications built with PySide6/PyQt. Universal patterns that work for any desktop tool — media players, editors, IDEs, admin panels, data viewers, or utilities.

This skill synthesizes modern design philosophy (bold minimalism, performance-first, micro-interactions, accessibility) with the constraints of desktop applications: native widget styling, real-time data display, and responsive window layouts.

## Core Design Principles
### 1. Performance-First

**Philosophy**: Desktop apps must feel instant. Every millisecond matters when rendering complex UIs and processing data.

**Key Metrics**:
- UI render time: < 16ms (one frame at 60fps)
- Widget response time: < 100ms on click
- Window drag/pan: 60fps smooth
- Data load (large datasets): progressive display, < 500ms initial render
- Memory usage: bounded caches, no leaks
**Implementation Guidelines**:
- Render complex widgets incrementally (progressive display)
- Use hardware-accelerated rendering where possible (QOpenGLWidget, QGraphicsView)
- Offload heavy computation to worker threads (QThread, QtConcurrent) — never block the main thread
- Cache rendered pixmaps and data views to avoid re-rendering
- Lazy-load content only when scrolled into view
- Use generators for large datasets instead of loading everything into memory
- Profile with `tracemalloc` and `cProfile` for performance monitoring
**Related Skills**: `skill-creator` for creating new project-specific skills
### 2. Bold Minimalism

**Characteristics**:
- Clean, uncluttered interfaces with ample whitespace
- Limited color palette (3-5 primary colors)
- Intentional use of accent colors to highlight actions and selections
- Standard-sized controls — no custom widgets where native ones suffice
- Large, readable text and labels
**Color System** (WCAG-compliant):
```python
DESIGN_TOKENS = {
    "colors": {
        "primary": "#2563EB",      # Blue — selected items, active controls, links
        "accent": "#F97316",       # Orange — highlights, warnings, markers
        "success": "#22C55E",      # Green — success states, exported data
        "danger": "#EF4444",       # Red — errors, invalid selections, destructive actions
        "warning": "#EAB308",      # Yellow — caution, pending states
        "neutral-50": "#F8FAFC",   # Light background
        "neutral-100": "#F1F5F9",  # Subtle backgrounds
        "neutral-200": "#E2E8F0",  # Borders, dividers
        "neutral-900": "#1E293B",  # Dark text, default foreground
        "text-secondary": "#64748B",  # Muted text, placeholders
    },
    "spacing": {
        "xs": 4, "sm": 8, "md": 16, "lg": 24, "xl": 32, "2xl": 48,
    },
    "radius": {
        "sm": 4, "md": 8, "lg": 16, "full": 9999,
    },
    "duration": {
        "instant": 50, "fast": 150, "normal": 250, "slow": 400,
    },
    "easing": {
        "ease-out": "ease-out",
        "ease-in-out": "ease-in-out",
        "spring": "ease-in-out",
    },
}
```
**Typography Scale** (Desktop app):
```python
FONT_SIZE_SMALL = 9    # Labels, secondary info, timestamps
FONT_SIZE_BASE = 11    # Body text, time displays, control labels
FONT_SIZE_LARGE = 14   # Section headers, titles
FONT_SIZE_XL = 18      # Dialog titles, panel headings
FONT_SIZE_2XL = 24     # Main application headings
```
**QSS Theme Template**:
```css
/* Base theme */
QWidget {
    font-family: "Inter", "Segoe UI", sans-serif;
    font-size: 11pt;
    color: #1E293B;
    background-color: #F8FAFC;
}

QPushButton {
    background-color: #2563EB;
    color: white;
    padding: 8px 24px;
    border-radius: 8px;
    border: none;
    font-weight: 600;
}

QPushButton:hover {
    background-color: #1D4ED8;
}

QPushButton:pressed {
    background-color: #1E40AF;
}

QPushButton:disabled {
    background-color: #94A3B8;
}
QLineEdit, QTextEdit, QComboBox {
    border: 1px solid #E2E8F0;
    border-radius: 8px;
    padding: 6px 12px;
    background-color: white;
}

QLineEdit:focus, QTextEdit:focus, QComboBox:focus {
    border-color: #2563EB;
    border-width: 2px;
}

QScrollBar:vertical {
    width: 10px;
    background: #F1F5F9;
    border-radius: 5px;
}

QScrollBar::handle:vertical {
    background: #94A3B8;
    border-radius: 5px;
    min-height: 30px;
}
```
**Related Skills**: `animated-component-libraries` for UI component patterns
### 3. Micro-Interactions

**Definition**: Small, purposeful animations and feedback that guide users and provide immediate response.

**Categories**:

**a) Widget Interactions**:
- Smooth hover effects on buttons and list items (200-300ms)
- Scale transformations on press (scale 0.95x, 50ms)
- Selection highlight fade-in/out (150ms)
- Progress indicator animations during processing
**b) Navigation Feedback**:
- Smooth transitions when switching tabs or panels
- Highlight current selection with accent color
- Visual pulse on operation completion
- Smooth scroll positioning when jumping to items

**c) Loading & Processing States**:
- Skeleton placeholders while loading data
- Animated progress bars for long operations
- Staggered reveal of results after processing
- Spinner/activity indicator during async work
**d) Drag & Drop**:
- Visual indicator when draggable element is picked up
- Drop zone highlight when hovering over valid target
- Smooth animation to final position on drop

**Implementation Example** (PySide6 with Qt Properties):
```python
from PySide6.QtCore import Property, QTimer, Signal
from PySide6.QtGui import QColor, QPainter
from PySide6.QtWidgets import QWidget

class InteractiveWidget(QWidget):
    """Widget with smooth micro-interactions."""
    def __init__(self, parent=None):
        super().__init__(parent)
        self._is_hovered = False
        self._animation_timer = QTimer()
        self._animation_timer.setInterval(16)  # ~60fps
        self._current_opacity = 1.0
        self.setMouseTracking(True)

    def enterEvent(self, event):
        self._is_hovered = True
        self._animate_property("opacity", 1.0, 200)

    def leaveEvent(self, event):
        self._is_hovered = False
        self._animate_property("opacity", 0.7, 200)
    def _animate_property(self, prop, target, duration):
        """Smooth animation using QTimer for 60fps."""
        start_val = getattr(self, f"_{prop}", 1.0)
        steps = duration // 16
        delta = (target - start_val) / steps
        def step():
            current = getattr(self, f"_{prop}", start_val)
            current += delta
            if abs(current - target) < 0.01:
                setattr(self, f"_{prop}", target)
                self._animation_timer.stop()
                self.update()
            else:
                setattr(self, f"_{prop}", current)
                self.update()

        self._animation_timer.timeout.connect(step)
        self._animation_timer.start()
```
### 4. Layout Architecture

**Layout Principles**:
- Use Qt's layout managers (QHBoxLayout, QVBoxLayout, QGridLayout) — never absolute positioning
- Set size policies on all widgets (Fixed, Expanding, Preferred, Minimum)
- Use stretch factors to distribute space intelligently
- Responsive layouts that adapt to window resizing
**Visual Hierarchy**:
1. **Primary**: Main content area (largest space, focal point)
2. **Secondary**: Navigation, toolbars, side panels
3. **Tertiary**: Status bars, info panels, settings
4. **Quaternary**: Help text, tooltips, empty states

**Common Layout Patterns**:
```
[Toolbar / Menu Bar]
[Sidebar | Main Content Area]
[Status Bar]
```

```
[Title Bar]
[Content with Tabs]
[Action Buttons at Bottom]
```

```
[Search/Filter Bar]
[Results List | Detail Panel]
[Toolbar]
```
### 5. Accessibility (WCAG AA)

**Keyboard Navigation**:
- All interactive widgets must have `setFocusPolicy(Qt.StrongFocus)`
- Provide keyboard shortcuts for all major actions
- Tab order must follow visual layout (logical reading order)
- Focus indicators must be visible (2px blue border via QSS)
**Focus Management**:
```python
button.setFocusPolicy(Qt.StrongFocus)
button.setStyleSheet("""
    QPushButton:focus {
        border: 2px solid #2563EB;
        border-radius: 8px;
    }
    QPushButton:focus:not(:focus) {
        border: none;
    }
""")
```
**Screen Reader Support**:
- Set `setAccessibleName()` on all interactive widgets
- Set `setAccessibleDescription()` for complex widgets
- Announce state changes using QAccessible
- Use semantic widget types (QPushButton, not QLabel with click handler)

**Reduced Motion**:
- Respect system accessibility settings
- Disable smooth animations when reduced motion is preferred
- Provide instant transitions as alternatives
**Color Contrast**:
- All text must have minimum 4.5:1 contrast ratio against background
- Never rely solely on color to convey information (use shape + icon + text)
- Test with tools like `colour-science` or `webcolors`
### 6. Component Architecture (Atomic Design for Desktop)

1. **Atoms**: QPushButton, QLineEdit, QLabel, QSpinBox, QSlider, QCheckBox
2. **Molecules**: Transport controls (play/pause/stop), search bar (QLineEdit + QPushButton), form fields
3. **Organisms**: Main toolbar, sidebar navigation, data table, file list
4. **Templates**: Main window layout, dialog layouts, wizard flows
5. **Pages**: Home view, Detail view, Settings view
**Component Reuse Rules**:
- Build a shared `components/` module with custom widgets
- Use Qt's style system (QSS) for consistent theming
- Never duplicate layout code — create reusable layout helpers
## Common Design Patterns

### Pattern 1: Data Display View
**Use Case**: Showing lists of items (files, records, results)

**Layout**:
```
[Filter/Search Bar]
[Table/List Widget]
[Detail Panel / Empty State]
```

**Implementation**:
- Use QTableView or QListWidget with custom delegates
- Alternating row colors for readability
- Selection highlighting with accent color
- Sortable columns
- Search/filter with instant feedback
### Pattern 2: Settings/Preferences Dialog
**Use Case**: User configuration and preferences

**Layout**:
```
[Category List (left)]
[Settings Panel (right)]
[Apply/Cancel/OK Buttons (bottom)]
```

**Implementation**:
- Tabbed dialog with categories
- Reset to defaults button
- Real-time preview where possible
- Auto-save on close or explicit Apply
### Pattern 3: Status/Progress View
**Use Case**: Showing processing progress, batch operations

**Layout**:
```
[Progress Bar]
[Task List with Status Icons]
[Cancel/Skip Buttons]
[Summary at Bottom]
```

### Pattern 4: Searchable List
**Use Case**: Finding items among many

**Layout**:
```
[Search Input]
[Filtered Results List]
[Item Detail on Select]
```

**Implementation**:
- Instant filtering as user types
- Highlight matching text in results
- Keyboard navigation (Up/Down/Enter)
- Clear search button
### Pattern 5: Split-View Editor
**Use Case**: Editing data with preview/controls

**Layout**:
```
[Sidebar with Tree/List | Editor Area]
```

**Implementation**:
- QSplitter for resizable panels
- Sidebar 25-30% width
- Editor fills remaining space
- Persistent splitter position via QSettings

## Integration with Other Skills

### `skill-creator`
Use for creating new project-specific desktop app skills.
### `animate` / `emil-design-eng`
For animation implementation details. Use Qt's animation framework (`QPropertyAnimation`, `QSequentialAnimationGroup`, `QEasingCurve`).

### `design-code`
For generating production-ready PySide6 UI code with proper token integration.

### `frontend-ui-engineering`
For general UI engineering principles that apply to desktop apps.

## Performance Optimization
### Data Loading
- Use generators for large datasets (lazy loading)
- Implement pagination for lists > 1000 items
- Use `QAbstractItemModel` subclasses for efficient data views
- Batch operations with progress reporting

### Rendering
- Use `QGraphicsView` for complex visual displays
- Cache rendered results with `QPixmapCache`
- Use `QThread` for background rendering
- Progressive rendering: show rough preview first, refine on idle
### Memory Management
- Limit caches to reasonable sizes (LRU cache)
- Unload data when not visible
- Use `tracemalloc` for leak detection
- Profile regularly with `cProfile`

## Common Pitfalls

### Pitfall 1: Blocking the Main Thread
**Problem**: Data processing freezes the UI.
**Solution**: Always use `QThread` or `QtConcurrent` for heavy operations.
### Pitfall 2: Hardcoded Layouts
**Problem**: Widgets overlap or don't resize properly.
**Solution**: Always use Qt layout managers — never set absolute positions.

### Pitfall 3: Inconsistent Theming
**Problem**: Different widgets use different styles, confusing users.
**Solution**: Centralize all styling in a single QSS stylesheet with design tokens.
### Pitfall 4: Missing Keyboard Shortcuts
**Problem**: Users expect standard desktop shortcuts.
**Solution**: Implement shortcuts and document them in a Help menu.

### Pitfall 5: No Undo Support
**Problem**: User can't revert changes.
**Solution**: Use `QUndoCommand` and `QUndoStack` for all editable operations.

### Pitfall 6: Ignoring High DPI
**Problem**: Text is blurry on retina/HiDPI displays.
**Solution**: Set `Qt.AA_EnableHighDpiScaling` and `Qt.AA_UseHighDpiPixmaps` at app startup.

## Resources
### References
- `accessibility_guide.md` - WCAG compliance for desktop apps
- `interaction_patterns.md` - Complete micro-interaction catalog
- `design_trends.md` - Current desktop UI trends
- `performance_checklist.md` - UI performance optimization

### Scripts
- `generate_ui.py` - Generate generic PySide6 UI components from templates
- `audit_ui.py` - Audit PySide6 UI code for design best practices
### Assets
- `templates/` - QWidget templates for common patterns
- `stylesheets/` - Base QSS stylesheet with design tokens
- `icons/` - SVG icon set for common actions

---

*Framework-agnostic design principles for Python desktop applications. Compatible with PySide6 and PyQt5/6.*
