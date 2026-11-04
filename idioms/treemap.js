/* Source-generation treemap for the selected year and country. */
window.SourceTreemap = (() => {
  const ALL_COUNTRIES = 'All countries';
  const AGGREGATE_COUNTRIES = new Set(['EU', 'Non-EU']);
  const LEAF_SOURCES = [
    'Coal', 'Gas', 'Other fossil', 'Nuclear', 'Solar', 'Wind', 'Hydro',
    'Bioenergy', 'Other renewables'
  ];
  const METRIC_UNITS = {
    share_pct: '%',
    generation_twh: 'TWh',
    emissions_intensity_gco2e_kwh: 'gCO₂e/kWh'
  };
  const METRIC_LABELS = {
    share_pct: 'Share of generation',
    generation_twh: 'Generation',
    emissions_intensity_gco2e_kwh: 'Emissions intensity'
  };
  const SOURCE_GROUPS = [
    {
      name: 'Fossil',
      children: ['Coal', 'Gas', 'Other fossil']
    },
    {
      name: 'Clean',
      children: [
        'Nuclear',
        {
          name: 'Renewables',
          children: ['Solar', 'Wind', 'Hydro', 'Bioenergy', 'Other renewables']
        }
      ]
    }
  ];

  const SOURCE_COLORS = {
    Coal: '#bf4040',
    Gas: '#bf7540',
    'Other fossil': '#bfaa40',
    Nuclear: '#6abf40',
    Bioenergy: '#40bf4a',
    Hydro: '#40bf80',
    Solar: '#40bfb5',
    Wind: '#4095bf',
    'Other renewables': '#4060bf'
  };
  let renderId = 0;
  const layoutCache = new WeakMap();

  function getMetricsBySource(rows, state) {
    const metricsBySource = new Map();

    rows.forEach(row => {
      const isSelectedCountry = state.country === ALL_COUNTRIES ||
        row.country === state.country;
      if (row.year !== state.year || !isSelectedCountry) return;

      const metrics = metricsBySource.get(row.source) || {
        generation_twh: 0,
        emissionsTotal: 0,
        emissionsCount: 0
      };

      const includeGeneration = state.country !== ALL_COUNTRIES ||
        AGGREGATE_COUNTRIES.has(row.country);
      const includeIntensity = state.country !== ALL_COUNTRIES ||
        !AGGREGATE_COUNTRIES.has(row.country);

      if (includeGeneration && Number.isFinite(row.generation_twh)) {
        metrics.generation_twh += row.generation_twh;
      }

      if (includeIntensity && Number.isFinite(row.emissions_intensity_gco2e_kwh)) {
        metrics.emissionsTotal += row.emissions_intensity_gco2e_kwh;
        metrics.emissionsCount += 1;
      }

      metricsBySource.set(row.source, metrics);
    });

    const totalGeneration = LEAF_SOURCES.reduce((total, source) =>
      total + (metricsBySource.get(source)?.generation_twh || 0), 0
    );

    metricsBySource.forEach(metrics => {
      metrics.share_pct = totalGeneration > 0
        ? metrics.generation_twh / totalGeneration * 100
        : null;
      metrics.emissions_intensity_gco2e_kwh = metrics.emissionsCount > 0
        ? metrics.emissionsTotal / metrics.emissionsCount
        : null;
    });

    return metricsBySource;
  }

  function createHierarchy(metricsBySource, metric) {
    function createNode(source) {
      if (typeof source === 'string') {
        const metrics = metricsBySource.get(source) || {};
        return {
          name: source,
          source,
          value: metrics[metric] || 0,
          metrics
        };
      }

      return {
        name: source.name,
        children: source.children.map(createNode)
      };
    }

    return {
      name: 'Total generation',
      children: SOURCE_GROUPS.map(createNode)
    };
  }

  function isActive(node, selectedSource) {
    if (selectedSource === 'Total generation') return true;
    return node.data.name === selectedSource ||
      node.data.source === selectedSource ||
      node.ancestors().some(ancestor => ancestor.data.name === selectedSource);
  }

  function handleKeyboardSelection(event, source, selectedSource, onSourceSelect) {
    if (event.key !== 'Enter' && event.key !== ' ') return;
    event.preventDefault();
    onSourceSelect(source === selectedSource
      ? 'Total generation'
      : source);
  }

  function fitTileText(selection, getText, getAvailableWidth, minCharacters = 3, hasSpace = () => true) {
    selection.each(function(node) {
      const text = getText(node);
      const availableWidth = Math.max(0, getAvailableWidth(node));
      const label = d3.select(this);
      if (!hasSpace(node)) {
        label.text('').attr('display', 'none');
        return;
      }
      label.text(text);

      if (this.getComputedTextLength() <= availableWidth) {
        label.attr('display', null);
        return;
      }

      const characters = Array.from(text);
      let fittedText = '';
      for (let length = characters.length - 1; length >= minCharacters; length -= 1) {
        const candidate = `${characters.slice(0, length).join('').trimEnd()}…`;
        label.text(candidate);
        if (this.getComputedTextLength() <= availableWidth) {
          fittedText = candidate;
          break;
        }
      }

      if (!fittedText && characters.length > 1) {
        const compactCandidate = `${characters[0]}...`;
        label.text(compactCandidate);
        if (this.getComputedTextLength() <= availableWidth) {
          fittedText = compactCandidate;
        }
      }

      if (fittedText) {
        label.text(fittedText).attr('display', null);
      } else {
        label.text('').attr('display', 'none');
      }
    });
  }

  function readRect(rect) {
    if (!rect) return null;
    return {
      x0: Number(rect.getAttribute('x')),
      y0: Number(rect.getAttribute('y')),
      x1: Number(rect.getAttribute('x')) + Number(rect.getAttribute('width')),
      y1: Number(rect.getAttribute('y')) + Number(rect.getAttribute('height'))
    };
  }

  function readCurrentLayout(containerNode) {
    const groups = new Map();
    const leaves = new Map();
    containerNode.querySelectorAll('.tree-group').forEach(group => {
      const bounds = readRect(group.querySelector('.tree-group-outline'));
      if (bounds) groups.set(group.__data__.data.name, bounds);
    });
    containerNode.querySelectorAll('.tree-tile-group').forEach(tile => {
      const bounds = readRect(tile.querySelector('.tree-rect'));
      if (bounds) leaves.set(tile.__data__.data.source, bounds);
    });
    return groups.size || leaves.size ? {groups, leaves} : null;
  }

  function scaleLayout(layout, width, height) {
    if (!layout?.width || !layout?.height || !width || !height) return null;
    const scaleX = width / layout.width;
    const scaleY = height / layout.height;
    const scaleBounds = bounds => ({
      x0: bounds.x0 * scaleX,
      y0: bounds.y0 * scaleY,
      x1: bounds.x1 * scaleX,
      y1: bounds.y1 * scaleY
    });
    return {
      groups: new Map([...layout.groups].map(([name, bounds]) => [name, scaleBounds(bounds)])),
      leaves: new Map([...layout.leaves].map(([source, bounds]) => [source, scaleBounds(bounds)]))
    };
  }

  function captureLayout(selector) {
    const containerNode = d3.select(selector).node();
    if (!containerNode || containerNode.querySelector('.treemap-small-multiple')) return null;
    const svg = containerNode.querySelector('svg.treemap-svg');
    const layout = readCurrentLayout(containerNode);
    if (!svg || !layout) return null;
    const viewBox = svg.viewBox.baseVal;
    return {...layout, width: viewBox.width, height: viewBox.height};
  }

  function render(selector, rows, state, onSourceSelect = () => {}, initialLayout = null) {
    const clipIdPrefix = `treemap-clip-${++renderId}`;
    const container = d3.select(selector);
    const containerNode = container.node();
    const card = containerNode.closest('.tree-card');
    const tooltip = d3.select('#treemap-tooltip');
    const {width, height} = containerNode.getBoundingClientRect();
    const previousLayout = readCurrentLayout(containerNode) ||
      scaleLayout(initialLayout, width, height) ||
      (containerNode.querySelector('.treemap-small-multiple')
        ? null
        : layoutCache.get(containerNode));
    const reduceMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    const duration = reduceMotion || !previousLayout ? 0 : 460;
    const animate = selection => duration
      ? selection.transition('treemap').duration(duration).ease(d3.easeCubicOut)
      : selection;
    containerNode.replaceChildren();
    tooltip.style('display', 'none').attr('aria-hidden', 'true');
    d3.select(card).select('.card-heading')
      .on('click.treemap-reset', event => {
        if (event.target.closest('#treemap-subtitle')) return;
        onSourceSelect('Total generation');
      });

    function positionTooltip(event) {
      const [x, y] = d3.pointer(event, card);
      const tooltipWidth = tooltip.node().offsetWidth;
      const tooltipHeight = tooltip.node().offsetHeight;
      const preferredLeft = x > card.clientWidth / 2
        ? x - tooltipWidth - 14
        : x + 14;
      const preferredTop = y > card.clientHeight / 2
        ? y - tooltipHeight - 14
        : y + 14;
      const left = Math.max(8, Math.min(preferredLeft, card.clientWidth - tooltipWidth - 8));
      const top = Math.max(8, Math.min(preferredTop, card.clientHeight - tooltipHeight - 8));
      tooltip.style('left', `${left}px`).style('top', `${top}px`);
    }

    function showTooltip(event, title, details, summaryValue) {
      tooltip.selectAll('*').remove();
      if (summaryValue !== undefined) {
        const heading = tooltip.append('div').attr('class', 'tooltip-heading-row');
        heading.append('strong').text(title);
        heading.append('b').text(summaryValue);
      } else {
        tooltip.append('strong').text(title);
      }
      details.forEach(detail => {
        const row = tooltip.append('div').attr('class', 'tooltip-row');
        row.append('span').text(detail.label);
        row.append('b').text(detail.value);
      });
      tooltip.style('display', 'grid').attr('aria-hidden', 'false');
      positionTooltip(event);
    }

    function hideTooltip() {
      tooltip.style('display', 'none').attr('aria-hidden', 'true');
    }

    if (width <= 0 || height <= 0) return {totalGeneration: 0};

    const metricsBySource = getMetricsBySource(rows, state);
    const hierarchyData = createHierarchy(metricsBySource, state.metric);
    const root = d3.hierarchy(hierarchyData)
      .sum(node => node.value || 0);

    if (!root.value) {
      layoutCache.delete(containerNode);
      const metricName = state.metric === 'emissions_intensity_gco2e_kwh'
        ? 'emissions-intensity'
        : state.metric === 'share_pct' ? 'share' : 'generation';
      container.text(`No ${metricName} data for ${state.country} in ${state.year}.`);
      return {totalGeneration: 0};
    }

    d3.treemap()
      .tile(d3.treemapSquarify)
      .size([width, height])
      .paddingOuter(4)
      .paddingInner(3)
      .paddingTop(node => node.depth === 1 || node.data.name === 'Renewables' ? 22 : 2)
      .round(true)(root);

    const groupNodes = root.descendants()
      .filter(node => node.children && node.depth > 0);
    const leaves = root.leaves().filter(node => node.value > 0);
    const currentLayout = {
      groups: new Map(groupNodes.map(node => [node.data.name, node])),
      leaves: new Map(leaves.map(node => [node.data.source, node]))
    };
    layoutCache.set(containerNode, currentLayout);

    const svg = container.append('svg')
      .attr('class', 'treemap-svg')
      .attr('viewBox', `0 0 ${width} ${height}`)
      .attr('preserveAspectRatio', 'xMidYMid meet')
      .attr('role', 'group')
      .attr('aria-label', `Generation mix for ${state.country}, ${state.year}`)
      .on('click', () => onSourceSelect('Total generation'));

    const exitingSources = previousLayout
      ? [...previousLayout.leaves.entries()]
        .filter(([source]) => !currentLayout.leaves.has(source))
      : [];
    const exitingTiles = svg.selectAll('.treemap-exit-tile')
      .data(exitingSources)
      .join('rect')
      .attr('class', 'tree-rect treemap-exit-tile')
      .attr('pointer-events', 'none')
      .attr('x', ([, bounds]) => bounds.x0)
      .attr('y', ([, bounds]) => bounds.y0)
      .attr('width', ([, bounds]) => Math.max(0, bounds.x1 - bounds.x0))
      .attr('height', ([, bounds]) => Math.max(0, bounds.y1 - bounds.y0))
      .attr('fill', ([source]) => SOURCE_COLORS[source] || '#8bb99a');

    if (duration) animate(exitingTiles).attr('opacity', 0).remove();
    else exitingTiles.remove();

    function selectSource(source, toggleCurrent = true) {
      onSourceSelect(toggleCurrent && source === state.source
        ? 'Total generation'
        : source);
    }

    const groups = svg.selectAll('.tree-group')
      .data(groupNodes)
      .join('g')
      .attr('class', node => {
        const groupName = node.data.name.toLowerCase().replace(/[^a-z0-9]+/g, '-');
        return `tree-group tree-group-${groupName}${isActive(node, state.source) ? ' active' : ''}`;
      })
      .attr('role', 'button')
      .attr('tabindex', 0)
      .attr('aria-label', node => `Select ${node.data.name} source`)
      .on('click', (event, node) => {
        event.stopPropagation();
        selectSource(node.data.name);
      })
      .on('keydown', (event, node) =>
        handleKeyboardSelection(event, node.data.name, state.source, onSourceSelect)
      )
      .on('pointerenter', (event, node) => {
        const details = node.leaves().map(leaf => ({
          label: leaf.data.name,
          value: formatMetric(leaf.data.metrics[state.metric], state.metric)
        }));
        showTooltip(
          event,
          node.data.name,
          details,
          formatMetric(node.value, state.metric)
        );
      })
      .on('pointermove', positionTooltip)
      .on('pointerleave', hideTooltip);

    const groupOutlines = groups.append('rect')
      .attr('class', 'tree-group-outline')
      .attr('x', node => {
        const bounds = previousLayout?.groups.get(node.data.name) || node;
        return bounds.x0;
      })
      .attr('y', node => {
        const bounds = previousLayout?.groups.get(node.data.name) || node;
        return bounds.y0;
      })
      .attr('width', node => {
        const bounds = previousLayout?.groups.get(node.data.name) || node;
        return Math.max(0, bounds.x1 - bounds.x0);
      })
      .attr('height', node => {
        const bounds = previousLayout?.groups.get(node.data.name) || node;
        return Math.max(0, bounds.y1 - bounds.y0);
      })
      .attr('fill', 'transparent');

    animate(groupOutlines)
      .attr('x', node => node.x0)
      .attr('y', node => node.y0)
      .attr('width', node => Math.max(0, node.x1 - node.x0))
      .attr('height', node => Math.max(0, node.y1 - node.y0));

    const groupLabels = groups.append('text')
      .attr('class', 'tree-group-label')
      .attr('x', node => (previousLayout?.groups.get(node.data.name) || node).x0 + 9)
      .attr('y', node => (previousLayout?.groups.get(node.data.name) || node).y0 + 17)
      .text(node => node.data.name)
      .each(function(node) {
        const availableWidth = node.x1 - node.x0 - 18;
        const availableHeight = node.y1 - node.y0;
        const fits = availableWidth >= this.getComputedTextLength() &&
          availableHeight >= 24;
        d3.select(this).attr('display', fits ? null : 'none');
      });
    animate(groupLabels)
      .attr('x', node => node.x0 + 9)
      .attr('y', node => node.y0 + 17);

    const defs = svg.append('defs');

    const clipRects = defs.selectAll('clipPath')
      .data(leaves)
      .join('clipPath')
      .attr('id', (node, index) => `${clipIdPrefix}-${index}`)
      .append('rect')
      .attr('x', node => (previousLayout?.leaves.get(node.data.source) || node).x0 + 5)
      .attr('y', node => (previousLayout?.leaves.get(node.data.source) || node).y0 + 4)
      .attr('width', node => Math.max(0, (previousLayout?.leaves.get(node.data.source) || node).x1 - (previousLayout?.leaves.get(node.data.source) || node).x0 - 10))
      .attr('height', node => Math.max(0, (previousLayout?.leaves.get(node.data.source) || node).y1 - (previousLayout?.leaves.get(node.data.source) || node).y0 - 8));
    animate(clipRects)
      .attr('x', node => node.x0 + 5)
      .attr('y', node => node.y0 + 4)
      .attr('width', node => Math.max(0, node.x1 - node.x0 - 10))
      .attr('height', node => Math.max(0, node.y1 - node.y0 - 8));

    const tiles = svg.selectAll('.tree-tile-group')
      .data(leaves)
      .join('g')
      .attr('class', node => {
        const classes = ['tree-tile-group'];
        if (isActive(node, state.source)) classes.push('active');
        if (node.data.source === state.source) classes.push('selected-source');
        return classes.join(' ');
      })
      .attr('role', 'button')
      .attr('tabindex', 0)
      .attr('aria-label', node => `Select ${node.data.name} source`)
      .on('click', (event, node) => {
        event.stopPropagation();
        selectSource(node.data.source);
      })
      .on('keydown', (event, node) =>
        handleKeyboardSelection(event, node.data.source, state.source, selectSource)
      )
      .on('pointerenter', (event, node) => {
        showTooltip(event, node.data.name, [{
          label: METRIC_LABELS[state.metric] || state.metric,
          value: formatMetric(node.data.metrics[state.metric], state.metric)
        }]);
      })
      .on('pointermove', positionTooltip)
      .on('pointerleave', hideTooltip);

    const tileRects = tiles.append('rect')
      .attr('class', 'tree-rect')
      .attr('x', node => {
        const bounds = previousLayout?.leaves.get(node.data.source);
        return bounds ? bounds.x0 : (node.x0 + node.x1) / 2;
      })
      .attr('y', node => {
        const bounds = previousLayout?.leaves.get(node.data.source);
        return bounds ? bounds.y0 : (node.y0 + node.y1) / 2;
      })
      .attr('width', node => {
        const bounds = previousLayout?.leaves.get(node.data.source);
        return bounds ? Math.max(0, bounds.x1 - bounds.x0) : 0;
      })
      .attr('height', node => {
        const bounds = previousLayout?.leaves.get(node.data.source);
        return bounds ? Math.max(0, bounds.y1 - bounds.y0) : 0;
      })
      .attr('opacity', node => previousLayout?.leaves.has(node.data.source) ? 1 : 0)
      .attr('fill', node => SOURCE_COLORS[node.data.source] || '#8bb99a');
    animate(tileRects)
      .attr('x', node => node.x0)
      .attr('y', node => node.y0)
      .attr('width', node => Math.max(0, node.x1 - node.x0))
      .attr('height', node => Math.max(0, node.y1 - node.y0))
      .attr('opacity', 1);

    const labels = tiles.append('text')
      .attr('class', 'tree-label')
      .attr('clip-path', (node, index) => `url(#${clipIdPrefix}-${index})`)
      .attr('x', node => (previousLayout?.leaves.get(node.data.source) || node).x0 + 10)
      .attr('y', node => (previousLayout?.leaves.get(node.data.source) || node).y0 + 20)
      .attr('opacity', node => previousLayout?.leaves.has(node.data.source) ? 1 : 0)
      .text(node => node.data.name);

    fitTileText(
      labels,
      node => node.data.name,
      node => node.x1 - node.x0 - 16,
      3,
      node => node.y1 - node.y0 >= 27
    );
    const visibleSourceNames = new Set(labels
      .filter(function() { return this.getAttribute('display') !== 'none'; })
      .data()
      .map(node => node.data.source));
    animate(labels)
      .attr('x', node => node.x0 + 10)
      .attr('y', node => node.y0 + 20)
      .attr('opacity', 1);

    const values = tiles.append('text')
      .attr('class', 'tree-value')
      .attr('clip-path', (node, index) => `url(#${clipIdPrefix}-${index})`)
      .attr('x', node => (previousLayout?.leaves.get(node.data.source) || node).x0 + 10)
      .attr('y', node => (previousLayout?.leaves.get(node.data.source) || node).y0 + 37)
      .attr('opacity', node => previousLayout?.leaves.has(node.data.source) ? 1 : 0)
      .text(node => formatMetric(node.data.metrics[state.metric], state.metric));

    fitTileText(
      values,
      node => formatMetric(node.data.metrics[state.metric], state.metric),
      node => node.x1 - node.x0 - 16,
      2,
      node => node.y1 - node.y0 >= 50 && visibleSourceNames.has(node.data.source)
    );
    animate(values)
      .attr('x', node => node.x0 + 10)
      .attr('y', node => node.y0 + 37)
      .attr('opacity', 1);

    return {totalGeneration: root.value};
  }

  function formatNumber(value, fractionDigits = 2) {
    return value.toLocaleString(undefined, {
      minimumFractionDigits: fractionDigits,
      maximumFractionDigits: fractionDigits
    });
  }

  function formatMetric(value, metric) {
    if (!Number.isFinite(value)) return 'No data';
    const formattedValue = formatNumber(
      value,
      metric === 'price_eur_kwh' ? 3 : 2
    );
    const unit = METRIC_UNITS[metric] || '';
    return `${formattedValue} ${unit}`.trim();
  }

  return {render, captureLayout};
})();
