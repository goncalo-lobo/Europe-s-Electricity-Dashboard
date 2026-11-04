/* Monthly generation heatmap, with aggregation aligned to the other idioms. */
window.CalendarHeatmap = (() => {
  const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
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
  let lastLegendKey = null;

  function aggregateMonth(rows, source, metric, country) {
    const selectedRows = country === 'All countries'
      ? rows.filter(row => row.area_type === 'region')
      : rows.filter(row => row.area === country);
    const sourceRows = selectedRows.filter(row => row.source === source);

    if (metric === 'generation_twh') {
      return d3.sum(sourceRows, row => row.total_generated);
    }

    if (metric === 'share_pct') {
      const sourceGeneration = d3.sum(sourceRows, row => row.total_generated);
      const totalGeneration = d3.sum(selectedRows.filter(row => row.source === 'Total generation'), row => row.total_generated);
      return totalGeneration > 0 ? sourceGeneration / totalGeneration * 100 : null;
    }

    const intensityRows = country === 'All countries'
      ? rows.filter(row => row.area_type === 'country' && row.source === source)
      : sourceRows;
    const intensities = intensityRows
      .filter(row => Number.isFinite(row.emissions_intensity_gco2e_kwh))
      .map(row => row.emissions_intensity_gco2e_kwh);
    return intensities.length ? d3.mean(intensities) : null;
  }

  function formatValue(value, metric) {
    if (!Number.isFinite(value)) return 'No data';
    const digits = metric === 'emissions_intensity_gco2e_kwh' ? 1 : 2;
    return `${d3.format(`,.${digits}f`)(value)} ${METRIC_UNITS[metric]}`;
  }

  function render(host, tooltipNode, rows, state, onYearSelect = () => {}) {
    const hostNode = typeof host === 'string' ? document.querySelector(host) : host;
    const tooltip = d3.select(tooltipNode);
    if (!hostNode) return;
    hostNode.replaceChildren();
    tooltip.style('display', 'none').attr('aria-hidden', 'true');
    hostNode.classList.remove('calendar-unavailable');
    if (!rows?.length) {
      hostNode.textContent = 'No monthly data is available.';
      return;
    }

    const byYearMonth = d3.group(rows, row => row.year, row => row.month);
    const years = [...byYearMonth.keys()].sort((a, b) => a - b);
    const countries = state.selectedCountries.length
      ? state.selectedCountries
      : ['All countries'];
    const valuesByCountry = new Map(countries.map(country => {
      const values = new Map();
      years.forEach(year => {
        MONTHS.forEach((_, index) => {
          const monthRows = byYearMonth.get(year)?.get(index + 1) || [];
          values.set(`${year}-${index + 1}`, aggregateMonth(monthRows, state.source, state.metric, country));
        });
      });
      return [country, values];
    }));
    // Keep the scale independent of the selected country and year. Include
    // every country's values and the regional aggregate for this source/metric.
    const allCountries = [...new Set(rows
      .filter(row => row.area_type === 'country')
      .map(row => row.area))];
    const scaleCountries = [...allCountries, 'All countries'];
    const finiteValues = [...byYearMonth].flatMap(([year, months]) =>
      [...months.keys()].flatMap(month => {
        const monthRows = byYearMonth.get(year)?.get(month) || [];
        return scaleCountries.map(country =>
          aggregateMonth(monthRows, state.source, state.metric, country)
        );
      })
    )
      .filter(Number.isFinite);
    const {color} = window.ChoroplethMap.createColorScale(
      finiteValues,
      state.source,
      'generation'
    );

    const comparison = d3.select(hostNode).append('div')
      .attr('class', `calendar-comparison${countries.length > 1 ? ' is-comparing' : ''}`);
    const extent = d3.extent(finiteValues);
    const legendKey = `${state.source}|${state.metric}|${extent.join('|')}`;
    const animateLegend = lastLegendKey !== null && lastLegendKey !== legendKey;
    lastLegendKey = legendKey;
    const legend = comparison.append('div')
      .attr('class', `calendar-color-legend${animateLegend ? ' is-scale-changing' : ''}`)
      .attr('aria-label', `Color scale from ${formatValue(extent[0], state.metric)} to ${formatValue(extent[1], state.metric)}`);
    legend.append('span').attr('class', 'calendar-legend-value').text(formatValue(extent[1], state.metric));
    legend.append('span')
      .attr('class', 'calendar-legend-gradient')
      .style('background', `linear-gradient(0deg, ${d3.range(5).map(index => {
        const position = index / 4;
        const value = extent[0] + (extent[1] - extent[0]) * position;
        return `${color(value)} ${position * 100}%`;
      }).join(', ')})`);
    legend.append('span').attr('class', 'calendar-legend-value').text(formatValue(extent[0], state.metric));

    const panels = comparison.append('div').attr('class', 'calendar-panels');
    countries.forEach(country => {
      const panel = panels.append('section').attr('class', 'calendar-country-panel');
      const grid = panel.append('div')
        .attr('class', 'calendar-heatmap-grid')
        .style('--calendar-year-count', years.length)
        .attr('role', 'table')
        .attr('aria-label', `Monthly ${METRIC_LABELS[state.metric].toLowerCase()} for ${state.source}, ${country}`);
      const header = grid.append('div').attr('class', 'calendar-heatmap-row calendar-heatmap-header').attr('role', 'row');
      header.append('span').attr('class', 'calendar-year-label').attr('role', 'columnheader').text('Year');
      MONTHS.forEach(month => header.append('span')
        .attr('class', 'calendar-month-label')
        .attr('role', 'columnheader')
        .text(month));

      years.forEach(year => {
        const isCurrentYear = year === state.year;
        const row = grid.append('div')
          .attr('class', `calendar-heatmap-row${isCurrentYear ? ' is-current-year' : ''}`)
          .attr('role', 'row')
          .attr('aria-label', `${year}${isCurrentYear ? ', selected year' : ''}`);
        row.append('span').attr('class', 'calendar-year-label').attr('role', 'rowheader').text(String(year));
        MONTHS.forEach((month, index) => {
          const value = valuesByCountry.get(country).get(`${year}-${index + 1}`);
          const cell = row.append('span')
            .attr('class', `calendar-heatmap-cell${Number.isFinite(value) ? '' : ' is-empty'}`)
            .attr('role', 'cell')
            .attr('aria-label', `${month} ${year}: ${formatValue(value, state.metric)}`)
            .on('click', () => onYearSelect(year))
            .on('pointerenter', event => {
              tooltip.selectAll('*').remove();
              tooltip.append('strong').text(`${month} ${year}`);
              tooltip.append('span').attr('class', 'tooltip-value').text(formatValue(value, state.metric));
              tooltip.append('span').attr('class', 'tooltip-context').text(`${country} · ${state.source} · ${METRIC_LABELS[state.metric]}`);
              tooltip.style('display', 'grid').attr('aria-hidden', 'false');
              positionTooltip(event);
            })
            .on('pointermove', positionTooltip)
            .on('pointerleave', () => tooltip.style('display', 'none').attr('aria-hidden', 'true'));
          if (Number.isFinite(value)) cell.style('background-color', color(value));
        });
      });
    });

    function positionTooltip(event) {
      const card = hostNode.closest('.calendar-panel');
      const [x, y] = d3.pointer(event, card);
      const tooltipWidth = tooltip.node().offsetWidth;
      const tooltipHeight = tooltip.node().offsetHeight;
      const left = x > card.clientWidth / 2 ? x - tooltipWidth - 10 : x + 10;
      const top = y > card.clientHeight / 2 ? y - tooltipHeight - 10 : y + 10;
      tooltip.style('left', `${Math.max(6, Math.min(left, card.clientWidth - tooltipWidth - 6))}px`)
        .style('top', `${Math.max(6, Math.min(top, card.clientHeight - tooltipHeight - 6))}px`);
    }
  }

  return {render};
})();
