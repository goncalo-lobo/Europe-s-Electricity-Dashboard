/* Synchronized small-multiple trends for generation sources and electricity price. */
window.SparklineTable = (() => {
  const YEARS = d3.range(2005, 2026);
  const SOURCES = [
    'Coal', 'Gas', 'Other fossil', 'Nuclear', 'Bioenergy', 'Hydro',
    'Solar', 'Wind', 'Other renewables'
  ];
  const COUNTRY_COLORS = ['#167486', '#861686'];
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
  const SOURCE_GROUPS = {
    Fossil: new Set(['Coal', 'Gas', 'Other fossil']),
    Clean: new Set(['Nuclear', 'Bioenergy', 'Hydro', 'Solar', 'Wind', 'Other renewables']),
    Renewables: new Set(['Bioenergy', 'Hydro', 'Solar', 'Wind', 'Other renewables'])
  };
  const EUROPE_COUNTRIES = ['EU', 'Non-EU'];
  const SVG_WIDTH = 240;
  const SVG_HEIGHT = 46;
  const LEFT_LABEL_GUTTER = 34;
  const RIGHT_LABEL_GUTTER = 34;

  function makeGenerationLookup(rows) {
    const lookup = new Map();
    rows.forEach(row => lookup.set(`${row.country}\u0000${row.year}\u0000${row.source}`, row));
    return lookup;
  }

  function formatValue(value, metric) {
    if (!Number.isFinite(value)) return '—';
    const digits = metric === 'price_eur_kwh' ? 3 : 2;
    return value.toLocaleString(undefined, {maximumFractionDigits: digits, minimumFractionDigits: digits});
  }

  function generationValue(lookup, countries, year, source, metric) {
    const rows = countries
      .map(country => lookup.get(`${country}\u0000${year}\u0000${source}`))
      .filter(Boolean);
    if (!rows.length) return null;

    if (metric === 'generation_twh') {
      const values = rows.map(row => row.generation_twh).filter(Number.isFinite);
      return values.length ? d3.sum(values) : null;
    }

    if (metric === 'share_pct') {
      if (countries.length === 1) return Number.isFinite(rows[0].share_pct) ? rows[0].share_pct : null;
      const sourceGeneration = d3.sum(rows, row => Number.isFinite(row.generation_twh) ? row.generation_twh : 0);
      const totals = countries
        .map(country => lookup.get(`${country}\u0000${year}\u0000Total generation`))
        .filter(row => Number.isFinite(row?.generation_twh));
      const totalGeneration = d3.sum(totals, row => row.generation_twh);
      return totalGeneration > 0 ? sourceGeneration / totalGeneration * 100 : null;
    }

    const weightedRows = rows.filter(row =>
      Number.isFinite(row.emissions_intensity_gco2e_kwh) &&
      Number.isFinite(row.generation_twh) && row.generation_twh > 0
    );
    const totalGeneration = d3.sum(weightedRows, row => row.generation_twh);
    return totalGeneration > 0
      ? d3.sum(weightedRows, row => row.emissions_intensity_gco2e_kwh * row.generation_twh) / totalGeneration
      : null;
  }

  function priceValue(rows, countries, year, allEurope = false) {
    const values = rows
      .filter(row => row.year === year && (allEurope || countries.includes(row.country)))
      .map(row => row.price_eur_kwh)
      .filter(Number.isFinite);
    return values.length ? d3.mean(values) : null;
  }

  function buildSeries(rows, priceRows, state) {
    const selectedCountries = state.selectedCountries || [];
    const countryGroups = selectedCountries.length
      ? selectedCountries.map((name, index) => {
        const allEurope = name === 'All countries';
        return {
          name,
          countries: allEurope ? EUROPE_COUNTRIES : [name],
          color: COUNTRY_COLORS[index],
          allEurope
        };
      })
      : [{name: 'Europe', countries: EUROPE_COUNTRIES, color: COUNTRY_COLORS[0], allEurope: true}];
    const generationLookup = makeGenerationLookup(rows);
    const years = YEARS.filter(year => state.sparkIncludePre2016 !== false || year >= 2016);
    const createSeries = (source, metric) => countryGroups.map(country => ({
      name: country.name,
      color: country.color,
      values: years.map(year => ({
        year,
        value: metric === 'price_eur_kwh'
          ? priceValue(priceRows, country.countries, year, country.allEurope)
          : generationValue(generationLookup, country.countries, year, source, metric)
      }))
    }));

    return [
      ...SOURCES.map(name => ({name, metric: state.metric, series: createSeries(name, state.metric)})),
      {name: 'Price', metric: 'price_eur_kwh', series: createSeries('Price', 'price_eur_kwh')}
    ];
  }

  function draw(selector, rows, priceRows, state, metricLabel, onSourceSelect, onPriceSelect, onYearSelect) {
    const container = d3.select(selector);
    const containerNode = container.node();
    if (!containerNode) return;
    const historyToggle = document.getElementById('spark-history-toggle');
    const sparkHeading = document.querySelector('.spark-panel .spark-heading');
    if (historyToggle && sparkHeading) {
      sparkHeading.append(historyToggle);
      sparkHeading.classList.remove('is-relocated');
    }
    sparkHeading?.querySelector('.spark-sources-title')?.remove();
    const charts = buildSeries(rows, priceRows, state);
    const firstYear = state.sparkIncludePre2016 === false ? 2016 : YEARS[0];
    const hasCurrentYear = state.year >= firstYear && state.year <= YEARS.at(-1);
    const yearPositionPercent = year => {
      const plotWidth = SVG_WIDTH - LEFT_LABEL_GUTTER - RIGHT_LABEL_GUTTER;
      return (LEFT_LABEL_GUTTER + (year - firstYear) / (YEARS.at(-1) - firstYear) * plotWidth) / SVG_WIDTH * 100;
    };
    const endpointIsCrowded = (endpointYear, hoveredYear = null) =>
      Math.abs(state.year - endpointYear) <= 2 ||
      (hoveredYear !== null && Math.abs(hoveredYear - endpointYear) <= 2);

    containerNode.replaceChildren();
    const headings = container.append('div').attr('class', 'spark-column-headings');
    headings.append('span').attr('aria-hidden', 'true');
    const yearHeading = headings.append('span').attr('class', 'spark-highlight-heading');
    const startYearLabel = yearHeading.append('span')
      .attr('class', 'spark-year-start')
      .style('left', `${yearPositionPercent(firstYear)}%`)
      .text(firstYear);
    const currentYearLabel = yearHeading.append('span')
      .attr('class', 'spark-current-year-label')
      .attr('aria-hidden', 'true')
      .text(state.year);
    const hoverYearLabel = yearHeading.append('span')
      .attr('class', 'spark-hover-year-label')
      .attr('aria-hidden', 'true')
      .style('display', 'none');
    const endYearLabel = yearHeading.append('span')
      .attr('class', 'spark-year-end')
      .style('left', `${yearPositionPercent(YEARS.at(-1))}%`)
      .text(YEARS.at(-1));

    let sourcesTitleAdded = false;
    let sourcesTitleNode = null;
    const chartInstances = charts.map(chart => {
      const isPrice = chart.metric === 'price_eur_kwh';
      if (!isPrice && !sourcesTitleAdded) {
        const sourcesTitle = container.append('h3')
          .attr('class', 'spark-section-title spark-sources-title')
          .text(metricLabel);
        sourcesTitleNode = sourcesTitle.node();
        sourcesTitleAdded = true;
      }
      if (isPrice) {
        container.append('div').attr('class', 'spark-price-divider');
      }
      const selectedGroup = SOURCE_GROUPS[state.source];
      const isSelectedSource = !isPrice && (selectedGroup
        ? selectedGroup.has(chart.name)
        : chart.name === state.source);
      const selectedGroupSources = selectedGroup
        ? SOURCES.filter(source => selectedGroup.has(source))
        : [];
      const groupPosition = selectedGroupSources.indexOf(chart.name);
      const groupOutlineClass = groupPosition >= 0
        ? ` is-group-selected${groupPosition === 0 ? ' is-group-first' : ''}${groupPosition === selectedGroupSources.length - 1 ? ' is-group-last' : ''}`
        : '';
      const row = container.append('div')
        .attr('class', `spark-row ${isPrice ? 'spark-row-price' : 'spark-row-source'}${isPrice && state.mapMode === 'price' ? ' is-price-mode' : ''}${isSelectedSource && !selectedGroup ? ' is-selected' : ''}${groupOutlineClass}`)
        .style('--spark-source-color', isPrice ? '#6096a6' : (SOURCE_COLORS[chart.name] || '#71818b'));
      const label = row.append('span').attr('class', 'spark-source-label');
      const sourceName = label.append('span')
        .attr('class', 'spark-source-name')
        .attr('title', isPrice ? 'Price (EUR/kWh)' : chart.name)
        .text(chart.name === 'Bioenergy' ? 'Bio\u00adenergy' : chart.name);
      if (isPrice) {
        sourceName
          .text('')
          .attr('role', 'button')
          .attr('tabindex', 0)
          .attr('aria-label', 'Show electricity price on the map')
          .on('click', onPriceSelect)
          .on('keydown', event => {
            if (event.key !== 'Enter' && event.key !== ' ') return;
            event.preventDefault();
            onPriceSelect();
          });
        sourceName.append('span').text('Price');
        sourceName.append('span').attr('class', 'spark-price-unit').text('(EUR/kWh)');
      } else {
        const selectSparklineSource = () => onSourceSelect?.(
          chart.name === state.source ? 'Total generation' : chart.name
        );
        sourceName
          .attr('role', 'button')
          .attr('tabindex', 0)
          .attr('aria-label', chart.name === state.source
            ? 'Show total generation'
            : `Filter dashboard to ${chart.name}`)
          .on('click', selectSparklineSource)
          .on('keydown', event => {
            if (event.key !== 'Enter' && event.key !== ' ') return;
            event.preventDefault();
            selectSparklineSource();
          });
      }
      const svg = row.append('svg')
        .attr('class', 'spark-chart')
        .attr('viewBox', `0 0 ${SVG_WIDTH} ${SVG_HEIGHT}`)
        // Keep the year axis fluid while compensating individual marks and text
        // for the chart's non-uniform responsive scale below.
        .attr('preserveAspectRatio', 'none')
        .attr('role', 'img')
        .attr('aria-label', `${chart.name} trend from ${firstYear} to ${YEARS.at(-1)}`);

      const numbers = chart.series.flatMap(series => series.values)
        .map(point => point.value)
        .filter(Number.isFinite);
      let [minimum, maximum] = d3.extent(numbers);
      if (minimum === undefined) [minimum, maximum] = [0, 1];
      if (minimum === maximum) {
        const pad = Math.abs(minimum) * .08 || 1;
        minimum -= pad;
        maximum += pad;
      } else {
        const pad = (maximum - minimum) * .1;
        minimum -= pad;
        maximum += pad;
      }
      const x = d3.scaleLinear().domain([firstYear, YEARS.at(-1)]).range([LEFT_LABEL_GUTTER, SVG_WIDTH - RIGHT_LABEL_GUTTER]);
      const y = d3.scaleLinear().domain([minimum, maximum]).range([SVG_HEIGHT - 4, 4]);
      currentYearLabel
        .style('left', `${yearPositionPercent(state.year)}%`)
        .style('display', hasCurrentYear ? null : 'none');
      startYearLabel.style('visibility', endpointIsCrowded(firstYear) ? 'hidden' : null);
      endYearLabel.style('visibility', endpointIsCrowded(YEARS.at(-1)) ? 'hidden' : null);
      const line = d3.line()
        .defined(point => Number.isFinite(point.value))
        .x(point => x(point.year))
        .y(point => y(point.value));
      const svgBounds = svg.node().getBoundingClientRect();
      const scaleX = svgBounds.width / SVG_WIDTH || 1;
      const scaleY = svgBounds.height / SVG_HEIGHT || 1;

      if (isPrice && firstYear < 2016) {
        const missingWidth = x(2016) - x(firstYear);
        const labelX = x(firstYear) + missingWidth / 2;
        const labelSizePx = Math.min(12, svgBounds.height * .28, missingWidth * scaleX / 7.5);
        svg.append('rect')
          .attr('class', 'spark-no-data-band')
          .attr('x', x(firstYear))
          .attr('y', 0)
          .attr('width', x(2016) - x(firstYear))
          .attr('height', SVG_HEIGHT);
        svg.append('text')
          .attr('class', 'spark-no-data-label')
          .attr('x', labelX)
          .attr('y', SVG_HEIGHT / 2)
          .attr('font-size', labelSizePx / scaleY)
          .attr('transform', `translate(${labelX}, ${SVG_HEIGHT / 2}) scale(${scaleY / scaleX}, 1) translate(${-labelX}, ${-SVG_HEIGHT / 2})`)
          .text('No price data');
      }

      svg.selectAll('.spark-line')
        .data(chart.series)
        .join('path')
        .attr('class', 'spark-line')
        .attr('d', series => line(series.values))
        .attr('stroke', series => series.color);
      svg.append('line')
        .attr('class', 'spark-current-year-guide')
        .attr('x1', x(state.year))
        .attr('x2', x(state.year))
        .attr('y1', 1)
        .attr('y2', SVG_HEIGHT - 1)
        .attr('display', hasCurrentYear ? null : 'none');
      const endpointPoints = chart.series.flatMap(series => [
        {series, point: series.values[0]},
        {series, point: series.values.at(-1)}
      ]).filter(entry => Number.isFinite(entry.point?.value));
      svg.selectAll('.spark-endpoint-dot')
        .data(endpointPoints)
        .join('ellipse')
        .attr('class', 'spark-endpoint-dot')
        .attr('cx', entry => x(entry.point.year))
        .attr('cy', entry => y(entry.point.value))
        .attr('rx', 2.7 / scaleX)
        .attr('ry', 2.7 / scaleY)
        .attr('fill', entry => entry.series.color)
        .attr('stroke', 'var(--paper)')
        .attr('stroke-width', 1.2)
        .attr('vector-effect', 'non-scaling-stroke')
        .attr('pointer-events', 'none');
      const selectedYearPoints = hasCurrentYear
        ? chart.series.map(series => ({
          series,
          point: series.values.find(point => point.year === state.year)
        })).filter(entry => Number.isFinite(entry.point?.value))
        : [];
      svg.selectAll('.spark-selected-year-dot')
        .data(selectedYearPoints)
        .join('ellipse')
        .attr('class', 'spark-selected-year-dot')
        .attr('cx', entry => x(entry.point.year))
        .attr('cy', entry => y(entry.point.value))
        .attr('rx', 2.7 / scaleX)
        .attr('ry', 2.7 / scaleY)
        .attr('fill', entry => entry.series.color)
        .attr('stroke', 'var(--paper)')
        .attr('stroke-width', 1.2)
        .attr('vector-effect', 'non-scaling-stroke')
        .attr('pointer-events', 'none');
      const guide = svg.append('line')
        .attr('class', 'spark-guide')
        .attr('y1', 1)
        .attr('y2', SVG_HEIGHT - 1)
        .attr('display', 'none');
      const dots = svg.selectAll('.spark-focus-dot')
        .data(chart.series)
        .join('ellipse')
        .attr('class', 'spark-focus-dot')
        .attr('rx', 2.7 / scaleX)
        .attr('ry', 2.7 / scaleY)
        .attr('fill', series => series.color)
        .attr('vector-effect', 'non-scaling-stroke')
        .attr('display', 'none');
      const hitTarget = svg.append('rect')
        .attr('class', 'spark-hit-target')
        .attr('width', SVG_WIDTH)
        .attr('height', SVG_HEIGHT)
        .attr('fill', 'transparent')
        .attr('pointer-events', 'all');
      function renderValueLabels(year, className) {
        const values = chart.series
          .map((series, index) => ({
            series,
            index,
            point: series.values.find(value => value.year === year)
          }))
          .filter(entry => Number.isFinite(entry.point?.value))
          .sort((a, b) => b.point.value - a.point.value || a.index - b.index);
        const isEndYear = year === YEARS.at(-1);
        const isFirstYear = year === firstYear;
        const isCurrentYearNearEnd = className === 'spark-current-year-value' &&
          year >= YEARS.at(-1) - 3 && year < YEARS.at(-1);
        const placeLeftOfPoint = isFirstYear || isCurrentYearNearEnd || x(year) > SVG_WIDTH - 48;
        const labelX = isEndYear
          ? x(year) + 4
          : placeLeftOfPoint ? x(year) - 4 : x(year) + 4;
        const textAnchor = isEndYear ? 'start' : placeLeftOfPoint ? 'end' : 'start';
        const bounds = svg.node().getBoundingClientRect();
        const scaleX = bounds.width / SVG_WIDTH || 1;
        const scaleY = bounds.height / SVG_HEIGHT || 1;
        const fontHeight = 12 / scaleY + 1;
        const labelGap = .5 / scaleY;
        const placedLabels = renderValueLabels.persistentLabelBoxes ||
          (renderValueLabels.persistentLabelBoxes = []);
        function lineCrossesLabel(left, right, top, bottom) {
          return chart.series.some(series => {
            for (let index = 1; index < series.values.length; index += 1) {
              const previous = series.values[index - 1];
              const current = series.values[index];
              if (!Number.isFinite(previous.value) || !Number.isFinite(current.value)) continue;
              const segmentLeft = x(previous.year);
              const segmentRight = x(current.year);
              const overlapLeft = Math.max(left, segmentLeft);
              const overlapRight = Math.min(right, segmentRight);
              if (overlapLeft > overlapRight) continue;
              const yAt = position => {
                const ratio = (position - segmentLeft) / (segmentRight - segmentLeft);
                return y(previous.value) + (y(current.value) - y(previous.value)) * ratio;
              };
              const y1 = yAt(overlapLeft);
              const y2 = yAt(overlapRight);
              if (Math.max(y1, y2) >= top - 2 && Math.min(y1, y2) <= bottom + 2) return true;
            }
            return false;
          });
        }
        const labelPositions = values.map(entry => {
          const labelText = formatValue(entry.point.value, chart.metric);
          const labelWidth = Math.max(10, labelText.length * 7 / scaleX);
          const pointY = y(entry.point.value);
          const candidates = d3.range(Math.ceil(fontHeight + 1), SVG_HEIGHT - 1)
            .sort((a, b) =>
              Math.abs((a - fontHeight / 2) - pointY) -
              Math.abs((b - fontHeight / 2) - pointY));
          const labelRank = values.indexOf(entry);
          const laneClearance = fontHeight / 2 + labelGap / 2 + 1;
          const laneCandidates = values.length < 2
            ? candidates
            : candidates.filter(candidate => labelRank === 0
              ? candidate <= SVG_HEIGHT / 2 - laneClearance
              : candidate >= SVG_HEIGHT / 2 + laneClearance);
          const higherValueLabel = labelRank > 0
            ? placedLabels.find(label => label.year === year && label.rank === 0)
            : null;
          const findPosition = requireLineClear => {
            const left = textAnchor === 'end' ? labelX - labelWidth : labelX;
            const right = textAnchor === 'end' ? labelX : labelX + labelWidth;
            const labelIsClear = candidate => {
              const top = candidate - fontHeight;
              const bottom = candidate + 2;
              const belowHigherValue = !higherValueLabel || top >= higherValueLabel.bottom + labelGap;
              const noLabelOverlap = !placedLabels.some(label =>
                left < label.right && right > label.left &&
                top < label.bottom + labelGap && bottom > label.top - labelGap
              );
              return belowHigherValue && noLabelOverlap &&
                (!requireLineClear || !lineCrossesLabel(left, right, top, bottom));
            };
            const baseline = laneCandidates.find(labelIsClear);
            return baseline === undefined ? null : {x: labelX, y: baseline, left, right, fontSize: null};
          };
          const placement = findPosition(true) || findPosition(false) || (() => {
            const left = textAnchor === 'end' ? labelX - labelWidth : labelX;
            const right = textAnchor === 'end' ? labelX : labelX + labelWidth;
            const baseline = laneCandidates.find(candidate =>
              !higherValueLabel || candidate - fontHeight >= higherValueLabel.bottom + labelGap
            ) ?? laneCandidates[0] ?? candidates[0] ?? pointY;
            return {x: labelX, y: baseline, left, right, fontSize: null};
          })();
          const placedLabel = {
            left: placement.left,
            right: placement.right,
            top: placement.y - fontHeight,
            bottom: placement.y + 2,
            year,
            value: entry.point.value,
            rank: labelRank
          };
          placedLabels.push(placedLabel);
          return placement;
        });
        svg.selectAll(`.${className}`)
          .data(values, entry => entry.series.name)
          .join('text')
          .attr('class', className)
          .attr('display', null)
          .attr('transform', (_, index) =>
            `translate(${labelPositions[index].x} ${labelPositions[index].y}) scale(${1 / scaleX} ${1 / scaleY})`)
          .attr('x', 0)
          .attr('y', 0)
          .attr('text-anchor', textAnchor)
          .attr('fill', entry => entry.series.color)
          .text(entry => formatValue(entry.point.value, chart.metric));
      }
      renderValueLabels(firstYear, 'spark-fixed-start-value');
      renderValueLabels(YEARS.at(-1), 'spark-fixed-end-value');
      if (hasCurrentYear && state.year !== firstYear && state.year !== YEARS.at(-1)) {
        renderValueLabels(state.year, 'spark-current-year-value');
      }
      return {chart, svg, x, y, guide, dots, hitTarget, renderValueLabels};
    });

    if (sourcesTitleNode && sparkHeading) sparkHeading.prepend(sourcesTitleNode);

    function clearGuides() {
      hoverYearLabel.style('display', 'none');
      currentYearLabel.style('display', hasCurrentYear ? null : 'none');
      startYearLabel.style('visibility', endpointIsCrowded(firstYear) ? 'hidden' : null);
      endYearLabel.style('visibility', endpointIsCrowded(YEARS.at(-1)) ? 'hidden' : null);
      chartInstances.forEach(chart => {
        chart.guide.attr('display', 'none');
        chart.dots.attr('display', 'none');
        chart.svg.selectAll('.spark-hover-value').attr('display', 'none');
      });
    }

    // Clear hover state whenever the pointer moves anywhere in the table
    // outside a chart hit area (including labels, gaps, and the year heading).
    container.on('pointermove', event => {
      if (!event.target.closest('.spark-hit-target')) clearGuides();
    });
    container.on('pointerleave', clearGuides);

    chartInstances.forEach(active => {
      active.hitTarget
        .on('click', event => {
          const [pointerX] = d3.pointer(event, active.svg.node());
          const year = Math.max(firstYear, Math.min(YEARS.at(-1), Math.round(active.x.invert(pointerX))));
          onYearSelect?.(year);
        })
        .on('pointermove', event => {
          const [pointerX] = d3.pointer(event, active.svg.node());
          const year = Math.max(firstYear, Math.min(YEARS.at(-1), Math.round(active.x.invert(pointerX))));
          hoverYearLabel
            .text(year)
            .style('left', `${yearPositionPercent(year)}%`)
            .style('display', null);
          currentYearLabel.style('display', hasCurrentYear && Math.abs(state.year - year) > 2 ? null : 'none');
          startYearLabel.style('visibility', endpointIsCrowded(firstYear, year) ? 'hidden' : null);
          endYearLabel.style('visibility', endpointIsCrowded(YEARS.at(-1), year) ? 'hidden' : null);
          chartInstances.forEach(chart => {
            chart.guide.attr('x1', chart.x(year)).attr('x2', chart.x(year)).attr('y2', SVG_HEIGHT - 1).attr('display', null);
            chart.dots
              .attr('cx', chart.x(year))
              .attr('cy', series => {
                const point = series.values.find(value => value.year === year);
                return Number.isFinite(point?.value) ? chart.y(point.value) : 0;
              })
              .attr('display', series => {
                const point = series.values.find(value => value.year === year);
                return Number.isFinite(point?.value) ? null : 'none';
              });
            chart.svg.selectAll('.spark-hover-value').attr('display', 'none');
          });
        });
    });
  }

  return {draw};
})();
