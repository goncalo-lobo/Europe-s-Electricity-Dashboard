/* Connected scatterplot for imports and the renewable balance. */
window.ConnectedScatterplot = (() => {
  const COUNTRY_COLORS = ['#167486', '#861686'];
  let lastDomains = null;
  let lastSelectionKey = null;
  let viewDomains = null;
  let renderId = 0;

  // Use the tick step to retain useful precision while zoomed, but never show
  // trailing zeroes (for example, "60" rather than "60.0").
  function tickFormatter(scale, tickCount) {
    const [start, end] = scale.domain();
    const step = Math.abs(d3.tickStep(start, end, tickCount));
    const precision = Number.isFinite(step) && step > 0
      ? Math.min(8, Math.max(0, d3.precisionFixed(step)))
      : 0;
    const format = d3.format(`,.${precision}f`);
    return value => {
      const label = format(Math.abs(value) < 1e-10 ? 0 : value);
      return label.includes('.') ? label.replace(/(?:\.0+|(?<=\.\d*?[1-9])0+)$/, '') : label;
    };
  }
  const percent = value => `${d3.format('.1f')(value)}%`;
  const starPath = () => d3.symbol().type(d3.symbolStar).size(88)();

  function pearson(values) {
    const usable = values.filter(d => Number.isFinite(d.importShare) && Number.isFinite(d.netRenewable));
    if (usable.length < 2) return null;
    const meanX = d3.mean(usable, d => d.importShare);
    const meanY = d3.mean(usable, d => d.netRenewable);
    const numerator = d3.sum(usable, d => (d.importShare - meanX) * (d.netRenewable - meanY));
    const denominator = Math.sqrt(d3.sum(usable, d => (d.importShare - meanX) ** 2) * d3.sum(usable, d => (d.netRenewable - meanY) ** 2));
    return denominator ? numerator / denominator : null;
  }

  function countrySeries(rows, country, milestones, color) {
    const milestoneByCountry = new Map(milestones.map(row => [row.country, row.milestone_year]));
    const byYear = d3.rollup(rows.filter(row => row.country === country), sourceRows => new Map(sourceRows.map(row => [row.source, row.share_pct])), row => row.year);
    const values = [...byYear].map(([year, sources]) => {
      const imports = sources.get('Net imports');
      const renewables = sources.get('Renewables');
      const fossil = sources.get('Fossil');
      const nuclear = sources.get('Nuclear');
      if (![imports, renewables, fossil, nuclear].every(Number.isFinite)) return null;
      return {country, year, xValue: imports, importShare: imports, netRenewable: renewables - (fossil + nuclear), milestone: milestoneByCountry.get(country) === year, color};
    }).filter(Boolean).sort((a, b) => a.year - b.year);
    return {country, color, values};
  }

  function allCountriesSeries(rows, color) {
    const byYear = d3.rollup(
      rows.filter(row => row.country === 'EU' || row.country === 'Non-EU'),
      sourceRows => d3.sum(sourceRows, row => row.generation_twh),
      row => row.year,
      row => row.source
    );
    const values = [...byYear].map(([year, sources]) => {
      const importsTwh = sources.get('Net imports');
      const totalGeneration = sources.get('Total generation');
      const nuclear = sources.get('Nuclear');
      const fossil = sources.get('Fossil');
      const renewables = sources.get('Renewables');
      if (![importsTwh, totalGeneration, nuclear, fossil, renewables].every(Number.isFinite) || !totalGeneration) return null;
      const importShare = importsTwh / totalGeneration * 100;
      const netRenewable = (renewables - nuclear - fossil) / totalGeneration * 100;
      return {country: 'All countries', year, xValue: importShare, importShare, netRenewable, milestone: false, color};
    }).filter(Boolean).sort((a, b) => a.year - b.year);
    const milestone = values.find(value => value.netRenewable > 0);
    if (milestone) milestone.milestone = true;
    return {country: 'All countries', color, values};
  }

  function fittedDomain(extent) {
    const span = Math.max(extent[1] - extent[0], 4);
    return [extent[0] - span * .08, extent[1] + span * .08];
  }

  function zoomDomains(domains, factor, centreX, centreY) {
    const zoom = (domain, centre) => [centre - (centre - domain[0]) * factor, centre + (domain[1] - centre) * factor];
    return {x: zoom(domains.x, centreX), y: zoom(domains.y, centreY)};
  }

  function placeTooltip(host, tooltip, event) {
    const box = host.getBoundingClientRect();
    const pad = 8;
    const width = tooltip.offsetWidth;
    const height = tooltip.offsetHeight;
    const pointX = event.clientX - box.left;
    const pointY = event.clientY - box.top;
    const left = Math.max(pad, Math.min(pointX - width - 14, box.width - width - pad));
    const right = Math.max(pad, Math.min(pointX + 14, box.width - width - pad));
    const above = Math.max(pad, Math.min(pointY - height - 14, box.height - height - pad));
    const below = Math.max(pad, Math.min(pointY + 14, box.height - height - pad));
    const candidates = [
      {left, top: above},
      {left, top: below},
      {left: right, top: above},
      {left: right, top: below}
    ];
    const controls = host.querySelector('.scatter-zoom-controls')?.getBoundingClientRect();
    const pointRects = [...host.querySelectorAll('.scatter-hit-target')]
      .map(point => point.getBoundingClientRect());
    const score = candidate => {
      const rect = {
        left: box.left + candidate.left,
        right: box.left + candidate.left + width,
        top: box.top + candidate.top,
        bottom: box.top + candidate.top + height
      };
      const coversControls = controls && rect.left < controls.right && rect.right > controls.left &&
        rect.top < controls.bottom && rect.bottom > controls.top;
      const coveredPoints = pointRects.reduce((count, point) => count + (
        rect.left < point.right + 4 && rect.right > point.left - 4 &&
        rect.top < point.bottom + 4 && rect.bottom > point.top - 4 ? 1 : 0
      ), 0);
      return (coversControls ? 1000000 : 0) + coveredPoints;
    };
    const placement = candidates.reduce((best, candidate) =>
      score(candidate) < score(best) ? candidate : best
    );
    tooltip.style.left = `${placement.left}px`;
    tooltip.style.top = `${placement.top}px`;
  }

  function render(host, rows, milestones, state, onYearSelect) {
    const container = typeof host === 'string' ? document.querySelector(host) : host;
    if (!container) return;
    const selected = state.selectedCountries.length ? state.selectedCountries : ['All countries'];
    const selectionKey = selected.join('|');
    const selectionChanged = lastSelectionKey !== null && lastSelectionKey !== selectionKey;
    if (selectionChanged) viewDomains = null;
    lastSelectionKey = selectionKey;
    // Keep the outgoing chart long enough for its marks to become the starting
    // state of the incoming one. Clearing it here made every filter change look
    // like a redraw, even though the scales were being transitioned below.
    const previousSvg = container.querySelector('.connected-scatter-svg');
    const previousOverlay = container.querySelector('.scatter-transition-overlay');
    if (previousOverlay) previousOverlay.remove();
    let transitionOverlay = null;
    if (selectionChanged && previousSvg) {
      transitionOverlay = previousSvg.cloneNode(true);
      const overlay = transitionOverlay;
      overlay.classList.add('scatter-transition-overlay');
      overlay.setAttribute('aria-hidden', 'true');
      overlay.style.pointerEvents = 'none';
    }
    container.replaceChildren();
    if (transitionOverlay) {
      container.append(transitionOverlay);
      d3.select(transitionOverlay)
        .transition().duration(550).ease(d3.easeCubicOut)
        .style('opacity', 0)
        .remove();
    }

    const series = selected.map((country, index) => country === 'All countries'
      ? allCountriesSeries(rows, COUNTRY_COLORS[index])
      : countrySeries(rows, country, milestones, COUNTRY_COLORS[index])
    ).filter(item => item.values.length);
    const observations = series.flatMap(item => item.values);
    if (!observations.length) {
      container.textContent = 'The selected countries do not have the data needed for this chart.';
      return;
    }
    const width = Math.max(280, container.clientWidth);
    const height = Math.max(220, container.clientHeight);
    const margin = {top: 28, right: 20, bottom: 45, left: 62};
    const fitted = {x: fittedDomain(d3.extent(observations, d => d.xValue)), y: fittedDomain(d3.extent(observations, d => d.netRenewable))};
    const domains = viewDomains || fitted;
    const x = d3.scaleLinear().domain(domains.x).range([margin.left, width - margin.right]);
    const y = d3.scaleLinear().domain(domains.y).range([height - margin.bottom, margin.top]);
    const priorX = lastDomains ? d3.scaleLinear().domain(lastDomains.x).range(x.range()) : x;
    const priorY = lastDomains ? d3.scaleLinear().domain(lastDomains.y).range(y.range()) : y;
    const animate = selectionChanged && lastDomains;
    lastDomains = {x: [...domains.x], y: [...domains.y]};
    const plotHeight = height - margin.top - margin.bottom;
    const plotWidth = width - margin.left - margin.right;
    const ticks = width < 420 ? 4 : 6;

    const controls = document.createElement('div');
    controls.className = 'map-zoom-controls scatter-zoom-controls';
    controls.setAttribute('role', 'group');
    controls.setAttribute('aria-label', 'Scatterplot zoom controls');
    [['in', '+', 'Zoom in'], ['out', '−', 'Zoom out'], ['reset', 'Reset', 'Reset zoom']].forEach(([command, label, description]) => {
      const button = document.createElement('button');
      button.type = 'button'; button.textContent = label; button.setAttribute('aria-label', description);
      button.addEventListener('click', () => {
        const current = viewDomains || fitted;
        const middleX = (current.x[0] + current.x[1]) / 2;
        const middleY = (current.y[0] + current.y[1]) / 2;
        viewDomains = command === 'reset' ? null : zoomDomains(current, command === 'in' ? .8 : 1.25, middleX, middleY);
        render(container, rows, milestones, state, onYearSelect);
      });
      controls.append(button);
    });
    container.append(controls);

    const svg = d3.select(container).append('svg').attr('class', 'connected-scatter-svg')
      .attr('viewBox', `0 0 ${width} ${height}`).attr('role', 'img')
      .attr('aria-label', 'Connected scatterplot of net imports and net renewable share by year');
    svg.append('desc').text('Each line connects yearly values for a selected country. Stars mark country milestones. Scroll to zoom and drag to pan.');
    // Clip data marks to the plotting rectangle so lines and points cannot
    // spill into the axes or surrounding controls when the view is zoomed.
    const plotClipId = `scatter-plot-clip-${++renderId}`;
    svg.append('defs').append('clipPath').attr('id', plotClipId)
      .append('rect')
      .attr('x', margin.left)
      .attr('y', margin.top)
      .attr('width', plotWidth)
      .attr('height', plotHeight);
    const previousTickFormatX = tickFormatter(priorX, ticks);
    const previousTickFormatY = tickFormatter(priorY, ticks);
    const tickFormatX = tickFormatter(x, ticks);
    const tickFormatY = tickFormatter(y, ticks);
    const gridX = svg.append('g').attr('class', 'scatter-grid scatter-grid-x').attr('transform', `translate(0,${height - margin.bottom})`)
      .call(d3.axisBottom(animate ? priorX : x).ticks(ticks).tickSize(-plotHeight).tickFormat(animate ? previousTickFormatX : tickFormatX));
    const gridY = svg.append('g').attr('class', 'scatter-grid scatter-grid-y').attr('transform', `translate(${margin.left},0)`)
      .call(d3.axisLeft(animate ? priorY : y).ticks(ticks).tickSize(-plotWidth).tickFormat(animate ? previousTickFormatY : tickFormatY));
    const containsZeroX = domains.x[0] <= 0 && domains.x[1] >= 0;
    const containsZeroY = domains.y[0] <= 0 && domains.y[1] >= 0;
    if (containsZeroY) svg.append('line').attr('class', 'scatter-zero-axis').attr('x1', margin.left).attr('x2', width - margin.right).attr('y1', y(0)).attr('y2', y(0));
    if (containsZeroX) svg.append('line').attr('class', 'scatter-zero-axis').attr('x1', x(0)).attr('x2', x(0)).attr('y1', margin.top).attr('y2', height - margin.bottom);
    if (animate) {
      const transition = svg.transition().duration(550).ease(d3.easeCubicOut);
      gridX.transition(transition).call(d3.axisBottom(x).ticks(ticks).tickSize(-plotHeight).tickFormat(tickFormatX));
      gridY.transition(transition).call(d3.axisLeft(y).ticks(ticks).tickSize(-plotWidth).tickFormat(tickFormatY));
    }
    svg.append('text').attr('class', 'scatter-axis-title').attr('text-anchor', 'middle').attr('x', margin.left + plotWidth / 2).attr('y', height - 8).text('Net imports (% of total generation)');
    svg.append('text').attr('class', 'scatter-axis-title').attr('text-anchor', 'middle').attr('transform', `translate(15,${margin.top + plotHeight / 2}) rotate(-90)`).text('Renewable - Non-Renewable (% of total generation)');

    const correlation = document.createElement('div');
    correlation.className = 'scatter-correlation';
    const correlationLabel = document.createElement('span');
    correlationLabel.className = 'scatter-correlation-label';
    correlationLabel.textContent = 'Pearson correlation:';
    correlation.append(correlationLabel);
    series.forEach(item => {
      const value = pearson(item.values);
      const chip = document.createElement('span');
      chip.className = 'scatter-correlation-chip';
      chip.style.setProperty('--correlation-color', item.color);
      chip.textContent = value == null ? '—' : d3.format('.2f')(value);
      correlation.append(chip);
    });
    container.append(correlation);

    const milestoneLegend = document.createElement('div');
    milestoneLegend.className = 'scatter-milestone-legend';
    milestoneLegend.setAttribute('aria-label', 'First year of positive net renewable generation');
    const legendIcon = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    legendIcon.setAttribute('viewBox', '-7 -7 14 14');
    legendIcon.setAttribute('aria-hidden', 'true');
    const legendStar = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    legendStar.setAttribute('d', starPath());
    legendStar.setAttribute('fill', '#71818b');
    legendStar.setAttribute('stroke', '#fff9ef');
    legendStar.setAttribute('stroke-width', '1.5');
    legendStar.setAttribute('stroke-linejoin', 'round');
    legendIcon.append(legendStar);
    milestoneLegend.append(legendIcon, document.createTextNode('First year of positive net renewable generation'));
    container.append(milestoneLegend);
    const tooltip = document.createElement('div');
    tooltip.className = 'chart-tooltip scatter-tooltip'; tooltip.setAttribute('role', 'tooltip'); tooltip.setAttribute('aria-hidden', 'true'); container.append(tooltip);
    const hideTooltip = () => { tooltip.style.display = 'none'; tooltip.setAttribute('aria-hidden', 'true'); };
    const showTooltip = (event, datum) => {
      tooltip.innerHTML = `<div class="tooltip-heading-row"><strong>${datum.country}</strong><b>${datum.year}</b></div><div class="tooltip-row"><span>Net imports</span><b>${percent(datum.xValue)}</b></div><div class="tooltip-row"><span>Net renewable share</span><b>${percent(datum.netRenewable)}</b></div>${datum.milestone ? '<div class="tooltip-context">Country milestone year</div>' : ''}`;
      tooltip.style.display = 'grid'; tooltip.setAttribute('aria-hidden', 'false'); placeTooltip(container, tooltip, event);
    };
    const lineAt = (scaleX, scaleY) => d3.line().x(d => scaleX(d.xValue)).y(d => scaleY(d.netRenewable));
    const groups = svg.append('g').attr('clip-path', `url(#${plotClipId})`)
      .selectAll('g').data(series).join('g').attr('class', 'scatter-series-group');
    const paths = groups.append('path').attr('class', 'scatter-line').attr('stroke', d => d.color).attr('d', d => lineAt(animate ? priorX : x, animate ? priorY : y)(d.values));
    const points = groups.selectAll('.scatter-point').data(d => d.values).join('g').attr('class', 'scatter-point').attr('transform', d => `translate(${(animate ? priorX : x)(d.xValue)},${(animate ? priorY : y)(d.netRenewable)})`);
    if (animate) {
      const transition = svg.transition().duration(550).ease(d3.easeCubicOut);
      paths.transition(transition).attr('d', d => lineAt(x, y)(d.values));
      points.transition(transition).attr('transform', d => `translate(${x(d.xValue)},${y(d.netRenewable)})`);
    }
    points.filter(d => d.milestone).append('path').attr('class', 'scatter-milestone').attr('d', starPath).attr('fill', d => d.color);
    points.filter(d => !d.milestone).append('circle').attr('class', 'scatter-dot').attr('r', 4).attr('fill', d => d.color);
    points.filter(d => d.year === state.year).append('circle').attr('class', 'scatter-selected-year').attr('r', d => d.milestone ? 8.5 : 6).attr('fill', 'none');
    points.append('circle').attr('class', 'scatter-hit-target').attr('r', 16).on('pointerenter', showTooltip).on('pointermove', showTooltip).on('pointerleave', hideTooltip).on('click', (event, datum) => { event.stopPropagation(); onYearSelect(datum.year); });

    svg.on('wheel', event => {
      event.preventDefault();
      const [pointerX, pointerY] = d3.pointer(event, svg.node());
      const factor = event.deltaY < 0 ? .88 : 1.14;
      viewDomains = zoomDomains(viewDomains || fitted, factor, x.invert(pointerX), y.invert(pointerY));
      render(container, rows, milestones, state, onYearSelect);
    }).call(d3.drag().subject(event => ({x: event.x, y: event.y, domains: viewDomains || fitted})).on('drag', event => {
      const origin = event.subject;
      const spanX = origin.domains.x[1] - origin.domains.x[0];
      const spanY = origin.domains.y[1] - origin.domains.y[0];
      const moveX = (event.x - origin.x) / plotWidth * spanX;
      const moveY = (event.y - origin.y) / plotHeight * spanY;
      viewDomains = {x: [origin.domains.x[0] - moveX, origin.domains.x[1] - moveX], y: [origin.domains.y[0] + moveY, origin.domains.y[1] + moveY]};
      render(container, rows, milestones, state, onYearSelect);
    }));
  }
  return {render};
})();
