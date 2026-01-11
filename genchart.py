#!/usr/bin/env python3
"""
RRD4J Chart Generator
Generates interactive HTML charts directly from rrd4j files
"""

import click
import struct
import math
import json
from pathlib import Path
from typing import List, Dict, Optional, Tuple
from datetime import datetime, timedelta
import time
import re


def deduce_unit(title: str) -> str:
    """Deduce the unit from the chart title (case insensitive)."""
    # Pattern: space before, space or end after
    def match_unit(pattern):
        return re.search(r'\s' + pattern + r'(\s|$)', title, re.IGNORECASE)

    if match_unit(r'kwh'):
        return 'kWh'
    if match_unit(r'%'):
        return '%'
    if match_unit(r'°c'):
        return '°C'
    if match_unit(r'mbar'):
        return 'mbar'
    if match_unit(r'l/min'):
        return 'l/min'
    if match_unit(r'm3'):
        return 'm³'
    if match_unit(r'v'):
        return 'V'
    if match_unit(r'w'):
        return 'W'
    if match_unit(r'lm/m2'):
        return 'lm/m²'

    return '?'


def parse_rrd4j_file(rrd_path: str, period: str = 'D') -> Optional[List[Tuple[float, float]]]:
    """Parse rrd4j file to extract timestamp-value pairs.

    RRD4J File Format (Big Endian):
    - Header: signature (40 bytes), step (8 bytes), dsCount (4 bytes), arcCount (4 bytes), lastUpdateTime (8 bytes)
    - Datasources: name (40), dsType (40), heartbeat (8), min (8), max (8), lastValue (8), accumValue (8), nanSeconds (8)
    - For each archive:
      - Definition: consolFun (40), xff (8), steps (4), rows (4)
      - ArcState per ds: accumValue (8), nanSteps (8)
      - Robin per ds: pointer (4), values (8 * rows)
    """
    try:
        with open(rrd_path, 'rb') as f:
            data = f.read()

        # Parse header in single unpack (step:Q, dsCount:I, arcCount:I, lastUpdate:Q)
        offset = 40  # Skip signature
        step, ds_count, arc_count, last_update = struct.unpack('>QIIQ', data[offset:offset+24])
        offset += 24

        if step < 1 or step > 86400:
            step = 60
        if last_update < 1577836800 or last_update > 2000000000:
            last_update = int(time.time())

        # Skip datasources (each is 40+40+8+8+8+8+8+8 = 128 bytes)
        offset += ds_count * 128

        # Parse each archive (definition + data are interleaved)
        archive_data = []
        for arc in range(arc_count):
            # Archive definition: consolFun (40) + xff (8) + steps (4) + rows (4)
            arc_steps, arc_rows = struct.unpack('>II', data[offset+48:offset+56])
            offset += 56

            # ArcState for each datasource (16 bytes each)
            offset += ds_count * 16

            # Robin for first datasource
            pointer = struct.unpack('>I', data[offset:offset+4])[0]
            offset += 4

            # Read all values in single unpack
            values_size = arc_rows * 8
            values = list(struct.unpack(f'>{arc_rows}d', data[offset:offset+values_size]))
            offset += values_size

            # Skip remaining datasources if any
            for ds in range(1, ds_count):
                offset += 4 + arc_rows * 8

            # Reorder values based on pointer (circular buffer)
            # pointer points to the NEXT write position
            # Values from pointer to end are oldest, then 0 to pointer-1 are newest
            if pointer > 0 and pointer < len(values):
                ordered_values = values[pointer:] + values[:pointer]
            else:
                ordered_values = values

            archive_data.append({
                'steps': arc_steps,
                'rows': arc_rows,
                'pointer': pointer,
                'values': ordered_values
            })

        # Select archive based on period
        period_duration = {
            'h': 3600,           # 1 hour
            'D': 24 * 3600,      # 1 day
            'W': 7 * 24 * 3600,  # 1 week
            'M': 30 * 24 * 3600, # 1 month
            'Y': 365 * 24 * 3600 # 1 year
        }
        required_duration = period_duration.get(period, 24 * 3600)

        # Find best archive (finest resolution that covers the period)
        selected = None
        for arc in archive_data:
            arc_step = step * arc['steps']
            arc_duration = arc['rows'] * arc_step
            if arc_duration >= required_duration * 0.8:
                selected = arc
                break

        # Fallback to archive with most coverage
        if selected is None:
            selected = max(archive_data, key=lambda a: a['rows'] * step * a['steps'])

        # Build timestamp-value pairs
        arc_step = step * selected['steps']
        values = selected['values']

        # Filter out NaN values and build pairs
        # Most recent value is at the END of ordered_values
        pairs = []
        for i, val in enumerate(values):
            if not math.isnan(val) and not math.isinf(val):
                ts = last_update - (len(values) - i - 1) * arc_step
                pairs.append((ts, val))

        return pairs if pairs else None

    except Exception as e:
        return None


def parse_rrd4j_values_only(rrd_path: str) -> Optional[List[Tuple[float, float]]]:
    """Fallback: extract values and generate synthetic timestamps."""
    try:
        with open(rrd_path, 'rb') as f:
            data = f.read()

        def is_valid_sensor_value(val):
            if math.isnan(val) or math.isinf(val):
                return False
            return 0.0001 < abs(val) < 10000

        blocks = []
        current_block = []
        current_start = None

        for i in range(200, len(data) - 8, 8):
            val = struct.unpack('>d', data[i:i+8])[0]
            if is_valid_sensor_value(val):
                if current_start is None:
                    current_start = i
                current_block.append(val)
            else:
                if len(current_block) >= 30:
                    blocks.append(current_block.copy())
                current_block = []
                current_start = None

        if len(current_block) >= 30:
            blocks.append(current_block)

        if not blocks:
            return None

        # Use the block with most values
        values = max(blocks, key=len)

        # Generate timestamps (1 minute intervals ending now)
        now = time.time()
        pairs = []
        for i, val in enumerate(values):
            ts = now - (len(values) - i - 1) * 60
            pairs.append((ts, val))

        return pairs

    except Exception:
        return None


def process_data(data: List[Tuple[float, float]], period: str, max_points: int = 500) -> Tuple[List[Tuple[float, float]], float, float]:
    """Filter, downsample, and calculate Y-range in optimized passes.

    Returns: (processed_data, y_min, y_max)
    """
    if not data:
        return [], 0, 100

    now = time.time()

    # Define period durations in seconds
    period_seconds = {
        'h': 3600,           # 1 hour
        'D': 24 * 3600,      # 1 day
        'W': 7 * 24 * 3600,  # 1 week
        'M': 30 * 24 * 3600, # 1 month
        'Y': 365 * 24 * 3600 # 1 year
    }

    duration = period_seconds.get(period, 24 * 3600)
    cutoff = now - duration

    # Single pass: filter and track min/max
    filtered = []
    data_min = float('inf')
    data_max = float('-inf')

    for ts, val in data:
        if ts >= cutoff:
            filtered.append((ts, val))
            if val < data_min:
                data_min = val
            if val > data_max:
                data_max = val

    # If no data in period, use most recent data available
    if not filtered and data:
        fallback_points = {
            'h': 60, 'D': 1440, 'W': 2016, 'M': 4320, 'Y': 8760
        }
        n = fallback_points.get(period, 1440)
        filtered = data[-n:]
        # Recalculate min/max for fallback data
        data_min = float('inf')
        data_max = float('-inf')
        for _, val in filtered:
            if val < data_min:
                data_min = val
            if val > data_max:
                data_max = val

    # Downsample if needed, tracking min/max
    if len(filtered) > max_points:
        step = len(filtered) / max_points
        result = []
        data_min = float('inf')
        data_max = float('-inf')

        for i in range(max_points):
            idx = int(i * step)
            if idx < len(filtered):
                ts, val = filtered[idx]
                result.append((ts, val))
                if val < data_min:
                    data_min = val
                if val > data_max:
                    data_max = val

        # Always include the last point
        if result and filtered and result[-1] != filtered[-1]:
            ts, val = filtered[-1]
            result.append((ts, val))
            if val < data_min:
                data_min = val
            if val > data_max:
                data_max = val

        filtered = result

    # Calculate nice Y-range from tracked min/max
    if data_min == float('inf'):
        return filtered, 0, 100

    data_range = data_max - data_min
    if data_range == 0:
        data_range = abs(data_max) * 0.1 if data_max != 0 else 1

    padding = data_range * 0.15
    y_min = data_min - padding
    y_max = data_max + padding

    if data_range > 0:
        range_magnitude = 10 ** math.floor(math.log10(data_range))
        step = range_magnitude / 10
        if step < 0.01:
            step = 0.01
        y_min = math.floor(y_min / step) * step
        y_max = math.ceil(y_max / step) * step

    if y_min == y_max:
        y_min -= 1
        y_max += 1

    return filtered, y_min, y_max


def generate_x_labels(data: List[Tuple[float, float]], period: str) -> List[Dict]:
    """Generate X-axis labels based on period type."""
    if not data:
        return []

    start_ts = data[0][0]
    end_ts = data[-1][0]
    duration = end_ts - start_ts

    labels = []

    if period == 'h':
        # Hour: show every 10-15 minutes
        interval = 600 if duration < 3600 else 900
        fmt = '%H:%M'
    elif period == 'D':
        # Day: show every 2 hours
        interval = 2 * 3600
        fmt = '%H:%M'
    elif period == 'W':
        # Week: show days
        interval = 24 * 3600
        fmt = '%a'  # Mon, Tue, etc.
    elif period == 'M':
        # Month: show every few days
        interval = 5 * 24 * 3600
        fmt = '%b %d'  # Jan 15, etc.
    elif period == 'Y':
        # Year: show months
        interval = 30 * 24 * 3600
        fmt = '%b'  # Jan, Feb, etc.
    else:
        interval = duration / 10
        fmt = '%H:%M'

    # Generate labels at regular intervals
    current = start_ts
    while current <= end_ts:
        dt = datetime.fromtimestamp(current)
        pos = ((current - start_ts) / duration) * 100 if duration > 0 else 50
        labels.append({
            'text': dt.strftime(fmt),
            'pos': pos
        })
        current += interval

    # Make sure we have end label
    if labels and labels[-1]['pos'] < 95:
        dt = datetime.fromtimestamp(end_ts)
        labels.append({
            'text': dt.strftime(fmt),
            'pos': 100
        })

    return labels


def generate_chart_data(data: List[Tuple[float, float]]) -> List[Dict]:
    """Convert data to chart format with x as percentage position."""
    if not data:
        return []

    start_ts = data[0][0]
    end_ts = data[-1][0]
    duration = end_ts - start_ts

    chart_data = []
    for i, (ts, val) in enumerate(data):
        x = ((ts - start_ts) / duration) * 100 if duration > 0 else 50
        chart_data.append({
            'x': round(x, 2),
            'y': round(val, 3),
            'index': i
        })

    return chart_data


def generate_html(chart_data: List[Dict], x_labels: List[Dict],
                  y_min: float, y_max: float, title: str, unit: str,
                  mode: str, period: str) -> str:
    """Generate the complete HTML chart."""

    theme = 'dark' if mode == 'dark' else 'light'

    # Period label for display
    period_labels = {
        'h': 'Last Hour',
        'D': 'Day',
        'W': 'Week',
        'M': 'Month',
        'Y': 'Year'
    }
    period_label = period_labels.get(period, period)

    html = f'''<!DOCTYPE html>
<html lang="en" data-theme="{theme}">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>{title}</title>
    <style>
        @font-face {{
            font-family: 'Rubik';
            src: url('/fonts/rubik-300.woff2') format('woff2');
            font-weight: 300;
            font-style: normal;
            font-display: swap;
        }}
        @font-face {{
            font-family: 'Rubik';
            src: url('/fonts/rubik-400.woff2') format('woff2');
            font-weight: 400;
            font-style: normal;
            font-display: swap;
        }}
        @font-face {{
            font-family: 'Rubik';
            src: url('/fonts/rubik-500.woff2') format('woff2');
            font-weight: 500;
            font-style: normal;
            font-display: swap;
        }}
        * {{
            margin: 0;
            padding: 0;
            box-sizing: border-box;
        }}

        :root {{
            --bg-primary: #f1f2f9;
            --bg-secondary: #e6e7f0;
            --bg-tertiary: #dbdce9;
            --bg-card: #dbdce9;
            --text-primary: #0f172a;
            --text-secondary: #475569;
            --text-muted: #94a3b8;
            --border-color: #ccccd1;
            --border-light: #ccccd1;
            --grid-color: rgba(148, 163, 184, 0.2);
            --chart-line: #ef4444;
            --chart-line-rgb: 239, 68, 68;
            --chart-gradient-start: rgba(239, 68, 68, 0.15);
            --chart-gradient-end: rgba(239, 68, 68, 0);
            --shadow-sm: 0 1px 2px 0 rgb(0 0 0 / 0.05);
            --shadow-md: 0 4px 6px -1px rgb(0 0 0 / 0.07), 0 2px 4px -2px rgb(0 0 0 / 0.05);
            --shadow-lg: 0 10px 15px -3px rgb(0 0 0 / 0.08), 0 4px 6px -4px rgb(0 0 0 / 0.05);
            --shadow-xl: 0 20px 25px -5px rgb(0 0 0 / 0.08), 0 8px 10px -6px rgb(0 0 0 / 0.04);
            --shadow-glow: 0 0 40px rgba(var(--chart-line-rgb), 0.15);
        }}

        [data-theme="dark"] {{
            --bg-primary: #080b28;
            --bg-secondary: #0e1130;
            --bg-tertiary: #131420;
            --bg-card: #131420;
            --text-primary: #fafafa;
            --text-secondary: #a1a1aa;
            --text-muted: #71717a;
            --border-color: #54555e;
            --border-light: #54555e;
            --grid-color: rgba(161, 161, 170, 0.1);
            --chart-line: #f87171;
            --chart-line-rgb: 248, 113, 113;
            --chart-gradient-start: rgba(248, 113, 113, 0.2);
            --chart-gradient-end: rgba(248, 113, 113, 0);
            --shadow-sm: 0 1px 2px 0 rgb(0 0 0 / 0.3);
            --shadow-md: 0 4px 6px -1px rgb(0 0 0 / 0.4), 0 2px 4px -2px rgb(0 0 0 / 0.3);
            --shadow-lg: 0 10px 15px -3px rgb(0 0 0 / 0.4), 0 4px 6px -4px rgb(0 0 0 / 0.3);
            --shadow-xl: 0 20px 25px -5px rgb(0 0 0 / 0.5), 0 8px 10px -6px rgb(0 0 0 / 0.4);
            --shadow-glow: 0 0 60px rgba(var(--chart-line-rgb), 0.2);
        }}

        html, body {{
            height: 100%;
            margin: 0;
            padding: 0;
            overflow: hidden;
        }}

        body {{
            font-family: 'Rubik', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
            background: var(--bg-primary);
            color: var(--text-primary);
            transition: background 0.3s ease, color 0.3s ease;
            line-height: 1.5;
        }}

        .container {{
            height: 100%;
        }}


        .chart-card {{
            background: var(--bg-card);
            height: 100%;
            display: flex;
            flex-direction: column;
        }}

        .chart-header {{
            display: flex;
            justify-content: space-between;
            align-items: center;
            padding: 1.25rem 1.5rem;
            border-bottom: 1px solid var(--border-light);
            gap: 1rem;
            flex-wrap: wrap;
        }}

        .chart-title-group {{
            min-width: 0;
            flex: 1;
        }}

        .chart-title {{
            font-size: 1.125rem;
            font-weight: 400;
            color: var(--text-primary);
            letter-spacing: -0.01em;
            white-space: nowrap;
            overflow: hidden;
            text-overflow: ellipsis;
        }}

        .chart-subtitle {{
            font-size: 0.8125rem;
            color: var(--text-muted);
            margin-top: 0.25rem;
        }}

        .chart-legend {{
            display: flex;
            align-items: center;
            gap: 0.5rem;
            font-size: 0.8125rem;
            font-weight: 500;
            color: var(--text-secondary);
            padding: 0.375rem 0.75rem;
            background: var(--bg-tertiary);
            border-radius: 8px;
            flex-shrink: 0;
        }}

        .legend-line {{
            width: 16px;
            height: 3px;
            background: var(--chart-line);
            border-radius: 2px;
            box-shadow: 0 0 6px rgba(var(--chart-line-rgb), 0.5);
        }}

        .data-point {{
            fill: var(--bg-card);
            stroke: var(--chart-line);
            stroke-width: 2.5;
            cursor: pointer;
            transition: all 0.2s ease;
            opacity: 0;
            animation: fadeIn 0.3s ease-out forwards;
        }}

        .data-point:hover {{
            r: 8;
            stroke-width: 3;
            filter: drop-shadow(0 0 8px rgba(var(--chart-line-rgb), 0.5));
        }}

        .tooltip {{
            position: absolute;
            background: var(--bg-primary);
            border: 1px solid var(--border-color);
            border-radius: 10px;
            padding: 0.5rem 0.75rem;
            box-shadow: var(--shadow-lg);
            pointer-events: none;
            opacity: 0;
            transform: translateY(8px);
            transition: all 0.2s ease;
            z-index: 100;
        }}

        .tooltip.visible {{
            opacity: 1;
            transform: translateY(0);
        }}

        .tooltip-value {{
            font-size: 1.125rem;
            font-weight: 400;
            color: var(--text-primary);
            letter-spacing: -0.01em;
        }}

        .tooltip-label {{
            font-size: 0.6875rem;
            font-weight: 500;
            color: var(--text-muted);
            margin-top: 0.125rem;
            text-transform: uppercase;
            letter-spacing: 0.05em;
        }}

        .chart-container {{
            position: relative;
            flex: 1;
            min-height: 0;
            padding: 1rem;
            padding-left: 2.5rem;
            padding-right: 2.5rem;
            padding-bottom: 1.25rem;
            background: var(--bg-primary);
        }}

        .chart-svg {{
            width: 100%;
            height: 100%;
            overflow: visible;
        }}

        .grid-line {{
            stroke: var(--grid-color);
            stroke-width: 1;
        }}

        .axis-label {{
            fill: var(--text-muted);
            font-size: 11px;
            font-weight: 500;
            font-family: 'Rubik', sans-serif;
        }}

        .chart-area {{
            fill: url(#areaGradient);
            opacity: 0;
            animation: fadeIn 0.8s ease-out 0.3s forwards;
        }}

        .chart-line {{
            fill: none;
            stroke: var(--chart-line);
            stroke-width: 2;
            stroke-linecap: round;
            stroke-linejoin: round;
            filter: drop-shadow(0 2px 4px rgba(var(--chart-line-rgb), 0.3));
            stroke-dasharray: 100000;
            stroke-dashoffset: 100000;
            animation: drawLine 2s ease-out forwards;
        }}

        .chart-line-glow {{
            fill: none;
            stroke: var(--chart-line);
            stroke-width: 8;
            stroke-linecap: round;
            stroke-linejoin: round;
            opacity: 0.12;
            filter: blur(4px);
            stroke-dasharray: 100000;
            stroke-dashoffset: 100000;
            animation: drawLine 2s ease-out forwards;
        }}


        .chart-header-right {{
            display: flex;
            align-items: center;
            gap: 0.75rem;
        }}

        @keyframes drawLine {{
            to {{ stroke-dashoffset: 0; }}
        }}

        @keyframes fadeIn {{
            to {{ opacity: 1; }}
        }}

        @media (max-width: 600px) {{
            .chart-container {{
                padding: 0.5rem;
                padding-left: 2rem;
                padding-right: 1.5rem;
                padding-bottom: 0.75rem;
            }}
            .chart-header {{
                padding: 0.75rem;
            }}
            .chart-title {{
                font-size: 1rem;
            }}
            .axis-label {{
                font-size: 9px;
            }}
        }}
    </style>
</head>
<body>
    <div class="container">
        <div class="chart-card">
            <div class="chart-header">
                <div class="chart-title-group">
                    <h2 class="chart-title">{title}</h2>
                </div>
                <div class="chart-header-right">
                    {f'<div class="chart-legend"><span class="legend-line"></span><span>{unit}</span></div>' if unit != '?' else ''}
                </div>
            </div>

            <div class="chart-container" id="chartContainer">
                <svg class="chart-svg" id="chartSvg"></svg>
                <div class="tooltip" id="tooltip">
                    <div class="tooltip-value" id="tooltipValue"></div>
                    <div class="tooltip-label" id="tooltipLabel"></div>
                </div>
            </div>
        </div>
    </div>

    <script>
        const chartData = {json.dumps(chart_data)};
        const xLabels = {json.dumps(x_labels)};
        const yMin = {y_min};
        const yMax = {y_max};
        const chartTitle = "{title}";
        const unit = "{unit}";

        (function() {{
            const params = new URLSearchParams(window.location.search);
            const mode = params.get('mode');
            if (mode === 'dark' || mode === 'light') {{
                document.documentElement.setAttribute('data-theme', mode);
                return;
            }}
            const saved = localStorage.getItem('theme');
            const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
            document.documentElement.setAttribute('data-theme', saved || (prefersDark ? 'dark' : 'light'));
        }})();

        class ChartRenderer {{
            constructor(containerId, svgId) {{
                this.container = document.getElementById(containerId);
                this.svg = document.getElementById(svgId);
                this.tooltip = document.getElementById('tooltip');
                this.tooltipValue = document.getElementById('tooltipValue');
                this.tooltipLabel = document.getElementById('tooltipLabel');
                this.padding = {{ top: 25, right: 45, bottom: 60, left: 35 }};
                this.points = [];
                this.init();
                window.addEventListener('resize', () => this.render());
            }}

            init() {{
                this.render();
            }}

            svg$(tag, attrs) {{
                const el = document.createElementNS('http://www.w3.org/2000/svg', tag);
                for (const k in attrs) el.setAttribute(k, attrs[k]);
                return el;
            }}

            render() {{
                const rect = this.container.getBoundingClientRect();
                const width = rect.width;
                const height = rect.height;
                const isSmall = width < 500;
                const padding = isSmall
                    ? {{ top: 15, right: 45, bottom: 40, left: 22 }}
                    : this.padding;
                const chartWidth = width - padding.left - padding.right;
                const chartHeight = height - padding.top - padding.bottom;
                const innerLeftMargin = isSmall ? 10 : 25;
                const innerRightMargin = isSmall ? 10 : 25;
                const drawWidth = chartWidth - innerLeftMargin - innerRightMargin;

                this.svg.innerHTML = '';
                const $ = (t, a) => this.svg$(t, a);

                // Defs
                const defs = $('defs', {{}});
                const gradient = $('linearGradient', {{id: 'areaGradient', x1: '0%', y1: '0%', x2: '0%', y2: '100%'}});
                gradient.appendChild($('stop', {{offset: '0%', style: 'stop-color: var(--chart-gradient-start)'}}));
                gradient.appendChild($('stop', {{offset: '50%', style: 'stop-color: var(--chart-gradient-start); stop-opacity: 0.6'}}));
                gradient.appendChild($('stop', {{offset: '100%', style: 'stop-color: var(--chart-gradient-end)'}}));
                defs.appendChild(gradient);

                // Horizontal grid fade mask
                const hMask = $('mask', {{id: 'hGridMask', maskUnits: 'objectBoundingBox', maskContentUnits: 'objectBoundingBox'}});
                const hGrad = $('linearGradient', {{id: 'hGridGrad', x1: '0%', y1: '0%', x2: '100%', y2: '0%'}});
                hGrad.innerHTML = '<stop offset="0%" stop-color="white" stop-opacity="0"/><stop offset="3%" stop-color="white" stop-opacity="1"/><stop offset="97%" stop-color="white" stop-opacity="1"/><stop offset="100%" stop-color="white" stop-opacity="0"/>';
                defs.appendChild(hGrad);
                hMask.appendChild($('rect', {{x: '0', y: '0', width: '1', height: '1', fill: 'url(#hGridGrad)'}}));
                defs.appendChild(hMask);

                // Vertical grid fade mask
                const vMask = $('mask', {{id: 'vGridMask', maskUnits: 'objectBoundingBox', maskContentUnits: 'objectBoundingBox'}});
                const vGrad = $('linearGradient', {{id: 'vGridGrad', x1: '0%', y1: '0%', x2: '0%', y2: '100%'}});
                vGrad.innerHTML = '<stop offset="0%" stop-color="white" stop-opacity="0"/><stop offset="3%" stop-color="white" stop-opacity="1"/><stop offset="97%" stop-color="white" stop-opacity="1"/><stop offset="100%" stop-color="white" stop-opacity="0"/>';
                defs.appendChild(vGrad);
                vMask.appendChild($('rect', {{x: '0', y: '0', width: '1', height: '1', fill: 'url(#vGridGrad)'}}));
                defs.appendChild(vMask);

                // Clip path
                const clipPath = $('clipPath', {{id: 'chartClip'}});
                clipPath.appendChild($('rect', {{x: '0', y: '0', width: chartWidth, height: chartHeight}}));
                defs.appendChild(clipPath);

                this.svg.appendChild(defs);

                const g = $('g', {{transform: `translate(${{padding.left}}, ${{padding.top}})`}});
                const hGridGroup = $('g', {{mask: 'url(#hGridMask)'}});
                const vGridGroup = $('g', {{mask: 'url(#vGridMask)'}});

                // Grid and Y labels
                const yRange = yMax - yMin;
                const numYLabels = isSmall ? 5 : 6;
                const unitSuffix = unit && unit !== '?' ? ' ' + unit : '';

                if (isSmall) {{
                    for (let i = 0; i < 5; i++) {{
                        const y = yMin + (yRange * i / 4);
                        const yPos = chartHeight - (i / 4) * chartHeight;
                        hGridGroup.appendChild($('line', {{class: 'grid-line', x1: 0, y1: yPos, x2: chartWidth, y2: yPos}}));
                        const label = $('text', {{class: 'axis-label', x: -8, y: yPos + 4, 'text-anchor': 'end'}});
                        label.textContent = this.formatNumber(y) + unitSuffix;
                        g.appendChild(label);
                    }}
                }} else {{
                    const yStep = this.niceStep(Math.abs(yRange), numYLabels);
                    const startY = Math.floor(yMin / yStep) * yStep;
                    for (let y = startY; y <= yMax + yStep * 0.1; y += yStep) {{
                        if (y < yMin - yStep * 0.1) continue;
                        const yPos = chartHeight - ((y - yMin) / yRange) * chartHeight;
                        if (yPos >= -5 && yPos <= chartHeight + 5) {{
                            hGridGroup.appendChild($('line', {{class: 'grid-line', x1: 0, y1: yPos, x2: chartWidth, y2: yPos}}));
                            const label = $('text', {{class: 'axis-label', x: -8, y: yPos + 4, 'text-anchor': 'end'}});
                            label.textContent = this.formatNumber(y) + unitSuffix;
                            g.appendChild(label);
                        }}
                    }}
                }}
                g.appendChild(hGridGroup);

                // X labels
                const maxXLabels = Math.min(xLabels.length, Math.floor(drawWidth / 70));
                const xLabelStep = Math.max(1, Math.ceil(xLabels.length / maxXLabels));
                xLabels.forEach((labelData, i) => {{
                    if (i % xLabelStep !== 0 && i !== xLabels.length - 1) return;
                    const labelText = typeof labelData === 'object' ? labelData.text : labelData;
                    const labelPos = typeof labelData === 'object' ? labelData.pos : null;
                    const xPos = labelPos !== null
                        ? innerLeftMargin + (labelPos / 100) * drawWidth
                        : innerLeftMargin + (xLabels.length > 1 ? (i / (xLabels.length - 1)) * drawWidth : drawWidth / 2);
                    vGridGroup.appendChild($('line', {{class: 'grid-line', x1: xPos, y1: 0, x2: xPos, y2: chartHeight}}));
                    const text = $('text', {{class: 'axis-label', x: xPos, y: chartHeight + 25, 'text-anchor': 'middle'}});
                    text.textContent = labelText;
                    g.appendChild(text);
                }});
                g.appendChild(vGridGroup);

                // Calculate points and track min/max in single pass
                this.points = [];
                let minPoint = null;
                let maxPoint = null;
                for (let i = 0; i < chartData.length; i++) {{
                    const d = chartData[i];
                    const pt = {{
                        x: innerLeftMargin + (d.x / 100) * drawWidth,
                        y: chartHeight - ((d.y - yMin) / yRange) * chartHeight,
                        value: d.y,
                        index: i
                    }};
                    this.points.push(pt);
                    if (!minPoint || pt.value < minPoint.value) minPoint = pt;
                    if (!maxPoint || pt.value > maxPoint.value) maxPoint = pt;
                }}

                if (this.points.length > 0) {{
                    const linePath = this.createPath(this.points);
                    const clippedGroup = $('g', {{'clip-path': 'url(#chartClip)'}});

                    // Area, Glow, Line
                    const areaPath = linePath + ` L ${{this.points[this.points.length - 1].x}} ${{chartHeight}} L ${{this.points[0].x}} ${{chartHeight}} Z`;
                    clippedGroup.appendChild($('path', {{class: 'chart-area', d: areaPath}}));
                    clippedGroup.appendChild($('path', {{class: 'chart-line-glow', d: linePath}}));
                    clippedGroup.appendChild($('path', {{class: 'chart-line', d: linePath}}));
                    g.appendChild(clippedGroup);

                    // Points at grid intersections and min/max (only for larger viewports)
                    if (!isSmall) {{
                        this.circleData = [];
                        const pointsGroup = $('g', {{class: 'data-points'}});

                        // Pre-compute grid X positions
                        const gridXPositions = [];
                        for (let i = 0; i < xLabels.length; i++) {{
                            const labelData = xLabels[i];
                            const labelPos = typeof labelData === 'object' ? labelData.pos : null;
                            if (labelPos !== null) {{
                                gridXPositions.push({{x: innerLeftMargin + (labelPos / 100) * drawWidth, delay: 1.2 + i * 0.05}});
                            }}
                        }}

                        // Min/max circles
                        const minMaxDelays = ['1.0s', '1.1s'];
                        [minPoint, maxPoint].forEach((pt, idx) => {{
                            const circle = $('circle', {{class: 'data-point', cx: pt.x, cy: pt.y, r: 5}});
                            circle.style.animationDelay = minMaxDelays[idx];
                            circle.dataset.idx = this.circleData.length;
                            this.circleData.push(pt);
                            pointsGroup.appendChild(circle);
                        }});

                        // Grid intersection circles
                        for (let i = 1; i < this.points.length; i++) {{
                            const prev = this.points[i - 1];
                            const curr = this.points[i];
                            const minX = Math.min(prev.x, curr.x);
                            const maxX = Math.max(prev.x, curr.x);
                            for (let j = gridXPositions.length - 1; j >= 0; j--) {{
                                const grid = gridXPositions[j];
                                if (grid.x >= minX && grid.x <= maxX) {{
                                    const t = (grid.x - prev.x) / (curr.x - prev.x);
                                    const interpY = prev.y + t * (curr.y - prev.y);
                                    const interpValue = prev.value + t * (curr.value - prev.value);
                                    const circle = $('circle', {{class: 'data-point', cx: grid.x, cy: interpY, r: 5}});
                                    circle.style.animationDelay = grid.delay + 's';
                                    circle.dataset.idx = this.circleData.length;
                                    this.circleData.push({{x: grid.x, y: interpY, value: interpValue}});
                                    pointsGroup.appendChild(circle);
                                    gridXPositions.splice(j, 1);
                                }}
                            }}
                        }}

                        // Event delegation for circles
                        pointsGroup.addEventListener('mouseenter', (e) => {{
                            if (e.target.classList.contains('data-point')) {{
                                this.showTooltip(e, this.circleData[e.target.dataset.idx]);
                            }}
                        }}, true);
                        pointsGroup.addEventListener('mouseleave', (e) => {{
                            if (e.target.classList.contains('data-point')) this.hideTooltip();
                        }}, true);
                        g.appendChild(pointsGroup);
                    }}
                }}

                this.svg.appendChild(g);
            }}

            createPath(points) {{
                if (points.length < 2) return '';
                const parts = [`M ${{points[0].x}} ${{points[0].y}}`];
                for (let i = 1; i < points.length; i++) {{
                    parts.push(`L ${{points[i].x}} ${{points[i].y}}`);
                }}
                return parts.join(' ');
            }}

            niceStep(range, targetSteps) {{
                const rough = range / targetSteps;
                const mag = Math.pow(10, Math.floor(Math.log10(rough)));
                const res = rough / mag;
                let nice = res <= 1.5 ? 1 : res <= 3 ? 2 : res <= 7 ? 5 : 10;
                return nice * mag;
            }}

            formatNumber(n) {{
                if (n === 0) return '0.0';
                if (Number.isInteger(n) || Math.abs(n - Math.round(n)) < 0.0001) {{
                    const rounded = Math.round(n);
                    if (Math.abs(rounded) >= 100) return rounded.toFixed(0);
                    return rounded.toFixed(1);
                }}
                if (Math.abs(n) >= 1000) return n.toFixed(0);
                if (Math.abs(n) >= 100) return n.toFixed(0);
                if (Math.abs(n) >= 10) return n.toFixed(1);
                if (Math.abs(n) >= 1) return n.toFixed(1);
                if (Math.abs(n) >= 0.1) return n.toFixed(2);
                return n.toFixed(2);
            }}

            showTooltip(event, point) {{
                const rect = this.container.getBoundingClientRect();
                const x = event.clientX - rect.left;
                const y = event.clientY - rect.top;

                this.tooltipValue.textContent = this.formatNumber(point.value) + (unit && unit !== '?' ? ' ' + unit : '');
                this.tooltipLabel.textContent = '';

                let tx = x + 15;
                let ty = y - 15;
                if (tx + 120 > rect.width) tx = x - 120;
                if (ty < 10) ty = y + 15;

                this.tooltip.style.left = tx + 'px';
                this.tooltip.style.top = ty + 'px';
                this.tooltip.classList.add('visible');
            }}

            hideTooltip() {{
                this.tooltip.classList.remove('visible');
            }}
        }}

        document.addEventListener('DOMContentLoaded', () => new ChartRenderer('chartContainer', 'chartSvg'));
    </script>
</body>
</html>'''

    return html


@click.command()
@click.option('-o', required=True, help='Output HTML file path')
@click.option('-mode', default='light', help='Theme mode: light or dark')
@click.option('-rrd', required=True, help='Path to rrd4j file')
@click.option('-period', default='D', help='Time period: h (4 hours), D (day), W (week), M (month), Y (year)')
@click.option('-title', default='BLANK', help='Chart title')
@click.option('-unit', default='?', help='Unit label')
def main(o: str, mode: str, rrd: str, period: str, title: str, unit: str):
    """Generate interactive HTML chart from rrd4j file."""

    # Auto-deduce unit from title if not specified
    if unit == '?':
        unit = deduce_unit(title)

    # Strip unit from end of title if present
    if unit != '?' and title.rstrip().endswith(unit):
        title = title.rstrip()[:-len(unit)].rstrip()

    # Parse rrd4j file (selects appropriate archive based on period)
    data = parse_rrd4j_file(rrd, period)

    if not data:
        click.echo(f"Error: Could not parse rrd4j file: {rrd}", err=True)
        return 1

    # Process data: filter, downsample, and calculate Y-range in optimized passes
    data, y_min, y_max = process_data(data, period, max_points=500)

    if not data:
        click.echo(f"Error: No data for period {period}", err=True)
        return 1

    # Generate chart components
    chart_data = generate_chart_data(data)
    x_labels = generate_x_labels(data, period)

    # Generate HTML
    html = generate_html(chart_data, x_labels, y_min, y_max, title, unit, mode, period)

    # Write output
    output_path = Path(o)
    output_path.parent.mkdir(parents=True, exist_ok=True)
    output_path.write_text(html)

    click.echo(f"Generated chart: {o}")


if __name__ == '__main__':
    main()
