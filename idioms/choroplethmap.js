/* Draw the D3 choropleth from the annual country and source export. */
window.ChoroplethMap = (() => {
  const CSV_TO_GEO_NAME = new Map([
    ['Bosnia and Herzegovina', 'Bosnia and Herz.'],
    ['North Macedonia', 'Macedonia'],
    ['Türkiye', 'Turkey']
  ]);

  const METRIC_LABELS = {
    share_pct: 'Share of generation (%)',
    generation_twh: 'Generation (TWh)',
    emissions_intensity_gco2e_kwh: 'Emissions intensity (gCO₂e/kWh)'
  };

  const METRIC_UNITS = {
    share_pct: '%',
    generation_twh: 'TWh',
    emissions_intensity_gco2e_kwh: 'gCO₂e/kWh'
  };

  METRIC_LABELS.price_eur_kwh = 'Average household electricity price (EUR/kWh)';
  METRIC_UNITS.price_eur_kwh = 'EUR/kWh';

  let zoomTransform = d3.zoomIdentity;
  let lastZoomViewport = null;
  let lastEmptyMapClick = null;
  let lastLegendKey = null;

  const EUROPE_BOUNDS = {
    longitudeMin: -14,
    longitudeMax: 33,
    latitudeMin: 34,
    latitudeMax: 69
  };

  const normalizeName = value => String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '');

  // Natural Earth names used by the World Atlas boundary file. Keeping this
  // list explicit prevents nearby North African and Asian countries from
  // appearing just because they touch the map's rectangular geographic bounds.
  const EUROPE_GEO_NAMES = new Set([
    'Albania', 'Andorra', 'Armenia', 'Austria', 'Azerbaijan', 'Belarus',
    'Belgium', 'Bosnia and Herz.', 'Bulgaria', 'Croatia', 'Cyprus', 'Czechia',
    'Denmark', 'Estonia', 'Finland', 'France', 'Georgia', 'Germany', 'Greece',
    'Hungary', 'Iceland', 'Ireland', 'Italy', 'Kazakhstan', 'Kosovo', 'Latvia',
    'Liechtenstein', 'Lithuania', 'Luxembourg', 'Macedonia', 'Malta', 'Moldova',
    'Monaco', 'Montenegro', 'Netherlands', 'Norway', 'Poland', 'Portugal',
    'Romania', 'Russia', 'San Marino', 'Serbia', 'Slovakia', 'Slovenia', 'Spain',
    'Sweden', 'Switzerland', 'Turkey', 'Ukraine', 'United Kingdom', 'Vatican', 'Vatican City'
  ].map(normalizeName));

  const FOSSIL_SOURCES = new Set(['Fossil', 'Coal', 'Gas', 'Other fossil']);
  const COLOR_RANGES = {
    green: ['#ffffff', '#b3e6c4', '#66cc88', '#339955', '#194d2b'],
    fossil: ['#ffffff', '#f2bfa6', '#e67f4c', '#b34d19', '#59260d'],
    price: ['#ffffff', '#b3d5e6', '#66aacc', '#337799', '#193c4d']
  };

  function formatNumber(value, fractionDigits = 2) {
    if (!Number.isFinite(value)) return 'No data';

    return value.toLocaleString(undefined, {
      minimumFractionDigits: fractionDigits,
      maximumFractionDigits: fractionDigits
    });
  }

  function getEuropeanPieces(feature) {
    const isRussia = normalizeName(feature.properties?.name) === 'russia';
    const polygons = feature.geometry.type === 'MultiPolygon'
      ? feature.geometry.coordinates
      : [feature.geometry.coordinates];

    return polygons
      .map(coordinates => ({
        type: 'Feature',
        properties: feature.properties,
        geometry: {type: 'Polygon', coordinates}
      }))
      .filter(piece => {
        // Keep Russia's full boundary so the SVG viewport crops it at the map edge.
        if (isRussia) return true;

        const [[west, south], [east, north]] = d3.geoBounds(piece);
        return east >= EUROPE_BOUNDS.longitudeMin &&
          west <= EUROPE_BOUNDS.longitudeMax &&
          north >= EUROPE_BOUNDS.latitudeMin &&
          south <= EUROPE_BOUNDS.latitudeMax;
      });
  }

  function matchCountryName(geoName, dataCountries) {
    const normalizedGeoName = normalizeName(geoName);

    return dataCountries.find(countryName => {
      const mappedName = CSV_TO_GEO_NAME.get(countryName) || countryName;
      return normalizeName(mappedName) === normalizedGeoName;
    });
  }

  function createProjection(width, height) {
    const {
      longitudeMin,
      longitudeMax,
      latitudeMin,
      latitudeMax
    } = EUROPE_BOUNDS;
    const fitBounds = {
      type: 'Polygon',
      coordinates: [[
        [longitudeMin, latitudeMin],
        [longitudeMin, latitudeMax],
        [longitudeMax, latitudeMax],
        [longitudeMax, latitudeMin],
        [longitudeMin, latitudeMin]
      ]]
    };

    // A conic projection suits Europe's east-west extent and avoids Mercator's
    // increasing north-south stretch. Fit to the regional bounds rather than
    // the full Russia geometry, which is intentionally clipped by the SVG.
    return d3.geoConicConformal()
      .center([(longitudeMin + longitudeMax) / 2, (latitudeMin + latitudeMax) / 2])
      .parallels([35, 65])
      .angle(-15)
      // Keep the map below the title and controls at its default position.
      .fitExtent([[16, 35], [width - 16, height - 16]], fitBounds);
  }

  function createColorScale(values, source, mapMode) {
    const extent = d3.extent(values);
    const colorRange = mapMode === 'price'
      ? COLOR_RANGES.price
      : FOSSIL_SOURCES.has(source) ? COLOR_RANGES.fossil : COLOR_RANGES.green;
    const color = extent[0] === undefined
      ? () => '#e8ece8'
      : extent[0] === extent[1]
        ? () => colorRange[colorRange.length - 1]
        : d3.scaleSequential(
          d3.piecewise(d3.interpolateRgb, colorRange)
        ).domain(extent);

    return {color, extent};
  }

  function render(selector, topology, rows, state, onCountrySelect = () => {}) {
    const mapContainer = d3.select(selector);
    const mapNode = mapContainer.node();
    const width = Math.max(1, mapNode.clientWidth);
    const height = Math.max(1, mapNode.clientHeight);
    if (lastZoomViewport && (lastZoomViewport.width !== width || lastZoomViewport.height !== height)) {
      zoomTransform = d3.zoomIdentity
        .translate(zoomTransform.x * width / lastZoomViewport.width,
          zoomTransform.y * height / lastZoomViewport.height)
        .scale(zoomTransform.k);
    }
    lastZoomViewport = {width, height};
    mapContainer.selectAll('*').remove();
    d3.select('#map-tooltip').style('display', 'none').attr('aria-hidden', 'true');

    const dataCountries = [...new Set(rows.map(row => row.country))];
    const features = topojson.feature(
      topology,
      topology.objects.countries
    ).features;
    const featuresByCountry = new Map();

    features.forEach(feature => {
      const geoName = feature.properties?.name;
      if (!geoName) return;

      const csvCountryName = matchCountryName(geoName, dataCountries);
      const isEuropeanCountry = EUROPE_GEO_NAMES.has(normalizeName(geoName)) ||
        csvCountryName !== undefined;
      if (!isEuropeanCountry) return;

      // Countries without a CSV row stay on the map and receive the no-data fill.
      const countryName = csvCountryName ||
        (normalizeName(geoName) === 'vatican' ? 'Vatican City' : geoName);

      const europeanPieces = getEuropeanPieces(feature);
      europeanPieces.forEach(piece => {
        piece.dataCountry = countryName;
      });

      if (europeanPieces.length) {
        featuresByCountry.set(countryName, europeanPieces);
      }
    });

    const mapFeatures = [...featuresByCountry.values()].flat();
    if (!mapFeatures.length) {
      throw new Error('No country boundaries matched the country names in the CSV.');
    }

    const projection = createProjection(width, height);
    const path = d3.geoPath(projection);
    const valueKey = state.mapMode === 'price' ? 'price_eur_kwh' : state.metric;
    const displayedValue = row => {
      const value = row[valueKey];
      if (state.mapMode !== 'price' &&
        state.metric === 'share_pct' &&
        state.source === 'Total generation' &&
        Number.isFinite(value) && Math.abs(value - 100) < 0.01) {
        return 100;
      }
      return value;
    };
    const precision = valueKey === 'price_eur_kwh' ? 3 : 2;
    const selectedCountries = new Set(state.selectedCountries?.length
      ? state.selectedCountries.filter(country => country !== 'All countries')
      : state.country === 'All countries' ? [] : [state.country]);
    const countriesWithData = new Set(rows
      .filter(row =>
        (state.mapMode === 'price' || row.source === state.source) &&
        Number.isFinite(displayedValue(row))
      )
      .map(row => row.country));
    const rowsForSelection = rows.filter(row =>
      row.year === state.year &&
      (state.mapMode === 'price' || row.source === state.source)
    );
    const valueByCountry = new Map(
      rowsForSelection.map(row => [row.country, displayedValue(row)])
    );
    const mapCard = mapContainer.node().closest('.map-card');
    const tooltip = d3.select('#map-tooltip');
    // Keep colors comparable while the selected year changes.
    const values = rows
      .filter(row => state.mapMode === 'price' || row.source === state.source)
      .filter(row => row.country !== 'EU' && row.country !== 'Non-EU')
      .map(displayedValue)
      .filter(Number.isFinite);
    const {color, extent} = createColorScale(values, state.source, state.mapMode);

    function positionTooltip(event) {
      const [x, y] = d3.pointer(event, mapCard);
      const tooltipWidth = tooltip.node().offsetWidth;
      const tooltipHeight = tooltip.node().offsetHeight;
      const preferredLeft = x > mapCard.clientWidth / 2
        ? x - tooltipWidth - 14
        : x + 14;
      const preferredTop = y > mapCard.clientHeight / 2
        ? y - tooltipHeight - 14
        : y + 14;
      const left = Math.max(8, Math.min(preferredLeft, mapCard.clientWidth - tooltipWidth - 8));
      const top = Math.max(8, Math.min(preferredTop, mapCard.clientHeight - tooltipHeight - 8));
      tooltip.style('left', `${left}px`).style('top', `${top}px`);
    }

    function showTooltip(event, feature) {
      const value = valueByCountry.get(feature.dataCountry);
      tooltip.selectAll('*').remove();
      tooltip.append('strong').text(feature.dataCountry);
      tooltip.append('span')
        .attr('class', 'tooltip-context')
        .text(state.mapMode === 'price'
          ? `Average household electricity price · ${state.year}`
          : `${state.source} · ${METRIC_LABELS[valueKey] || valueKey} · ${state.year}`);
      tooltip.append('span')
        .attr('class', 'tooltip-value')
        .text(Number.isFinite(value)
          ? `${formatNumber(value, precision)} ${METRIC_UNITS[valueKey] || ''}`.trim()
          : 'No data');
      tooltip.style('display', 'grid').attr('aria-hidden', 'false');
      positionTooltip(event);
    }

    function hideTooltip() {
      tooltip.style('display', 'none').attr('aria-hidden', 'true');
    }

    d3.select(mapCard)
      .on('pointermove.tooltip-dismiss', event => {
        if (!event.target.closest('.choropleth-country-hit')) hideTooltip();
      })
      .on('pointerleave.tooltip-dismiss', hideTooltip);

    const map = mapContainer.append('svg')
      .attr('class', 'choropleth-svg')
      .attr('viewBox', `0 0 ${width} ${height}`)
      .attr('role', 'group')
      .attr('aria-label', `${state.mapMode === 'price' ? 'Electricity price' : 'Generation'} map of Europe for ${state.year}`);

    const mapLayer = map.append('g').attr('class', 'map-content');
    const countryPaths = mapLayer.append('g')
      .attr('class', 'choropleth-countries')
      .selectAll('path')
      .data(mapFeatures)
      .join('path')
      .attr('class', feature =>
        `choropleth-country${selectedCountries.has(feature.dataCountry) ? ' selected' : ''}`
      )
      .attr('d', path)
      .attr('fill', feature => {
        const value = valueByCountry.get(feature.dataCountry);
        return Number.isFinite(value) ? color(value) : '#727272';
      })
      .attr('pointer-events', 'none');

    // Put the smallest countries last so their expanded hit areas stay reachable
    // where they overlap a neighboring country's boundary.
    const countryHitFeatures = [...mapFeatures]
      .sort((a, b) => d3.geoArea(b) - d3.geoArea(a));
    const countryHitTargets = mapLayer.append('g')
      .attr('class', 'choropleth-hit-targets')
      .selectAll('path')
      .data(countryHitFeatures)
      .join('path')
      .attr('class', 'choropleth-country-hit')
      .attr('d', path)
      .attr('fill', 'transparent')
      .attr('stroke', 'transparent')
      .attr('stroke-width', 14)
      .attr('pointer-events', 'all')
      .attr('aria-disabled', feature => String(!countriesWithData.has(feature.dataCountry)))
      .attr('aria-label', feature => {
        if (!countriesWithData.has(feature.dataCountry)) {
          return `${feature.dataCountry}: no data for this map selection`;
        }
        return `${feature.dataCountry}: ${formatNumber(valueByCountry.get(feature.dataCountry), precision)} ${METRIC_UNITS[valueKey] || ''}`.trim();
      });

    const zoom = d3.zoom()
      .scaleExtent([1, 8])
      .extent([[0, 0], [width, height]])
      .translateExtent([[0, 0], [width, height]])
      .clickDistance(4)
      .on('zoom', event => {
        zoomTransform = event.transform;
        mapLayer.attr('transform', zoomTransform);
      });

    zoomTransform = zoom.constrain()(
      zoomTransform,
      [[0, 0], [width, height]],
      [[0, 0], [width, height]]
    );
    map.call(zoom).call(zoom.transform, zoomTransform);
    // D3 zooms toward the pointer on a double-click by default. Country
    // selection redraws the SVG after each click, so rapid selections can
    // otherwise be mistaken for a double-click and jump to that location.
    map.on('dblclick.zoom', null);
    mapContainer.on('click.map-background', event => {
      if (!event.target.closest('.choropleth-svg')) return;
      const now = Date.now();
      const previous = lastEmptyMapClick;
      const isDoubleClick = previous && now - previous.time <= 500 &&
        Math.hypot(event.clientX - previous.x, event.clientY - previous.y) <= 12;
      lastEmptyMapClick = isDoubleClick
        ? null
        : {time: now, x: event.clientX, y: event.clientY};
      if (isDoubleClick) zoomTransform = d3.zoomIdentity;
      // This callback redraws the SVG. Keeping click detection on the stable
      // container lets the second click complete even after that redraw.
      onCountrySelect('All countries');
    });

    const zoomControls = d3.select(mapCard).select('.map-zoom-controls');
    zoomControls.select('[data-map-zoom="in"]')
      .on('click.map-zoom', event => {
        event.stopPropagation();
        map.transition().duration(180).call(zoom.scaleBy, 1.5);
      });
    zoomControls.select('[data-map-zoom="out"]')
      .on('click.map-zoom', event => {
        event.stopPropagation();
        map.transition().duration(180).call(zoom.scaleBy, 1 / 1.5);
      });
    zoomControls.select('[data-map-zoom="reset"]')
      .on('click.map-zoom', event => {
        event.stopPropagation();
        map.transition().duration(220).call(zoom.transform, d3.zoomIdentity);
      });

    countryPaths
      .filter(feature => selectedCountries.has(feature.dataCountry))
      .raise();

    countryHitTargets
      .on('pointerenter', (event, hoveredFeature) => {
        countryPaths.classed(
          'hovered',
          feature => feature.dataCountry === hoveredFeature.dataCountry
        );
        countryPaths
          .filter(feature => feature.dataCountry === hoveredFeature.dataCountry)
          .raise();
        countryPaths
          .filter(feature => selectedCountries.has(feature.dataCountry))
          .raise();
        showTooltip(event, hoveredFeature);
      })
      .on('pointermove', event => {
        positionTooltip(event);
      })
      .on('pointerleave', (event, hoveredFeature) => {
        countryPaths
          .filter(feature => feature.dataCountry === hoveredFeature.dataCountry)
          .classed('hovered', false);
        countryPaths
          .filter(feature => selectedCountries.has(feature.dataCountry))
          .raise();
        hideTooltip();
      })
      .on('click', (event, feature) => {
        event.stopPropagation();
        if (!countriesWithData.has(feature.dataCountry)) return;
        onCountrySelect(feature.dataCountry, true);
      });

    countryHitTargets
      .attr('role', 'button')
      .attr('tabindex', 0)
      .on('keydown', (event, feature) => {
        if (event.key !== 'Enter' && event.key !== ' ') return;
        event.preventDefault();
        if (!countriesWithData.has(feature.dataCountry)) return;
        onCountrySelect(feature.dataCountry, true);
      });

    countryPaths.append('title')
      .text(feature =>
        `${feature.dataCountry} · ${formatNumber(valueByCountry.get(feature.dataCountry), precision)}`
      );

    countryPaths.selectAll('title').remove();
    renderLegend(color, extent, valueKey);
    return {mappedCountries: featuresByCountry.size};
  }

  function renderLegend(color, extent, metric) {
    const unit = METRIC_UNITS[metric] || '';
    const label = METRIC_LABELS[metric] || metric;
    const precision = metric === 'price_eur_kwh' ? 3 : 2;
    const legendHost = d3.select('#map-legend');
    const legendKey = `${metric}|${extent.join('|')}`;
    const animateLegend = lastLegendKey !== null && lastLegendKey !== legendKey;
    lastLegendKey = legendKey;
    legendHost.selectAll('*').remove();

    const legend = legendHost.append('svg')
      .attr('class', animateLegend ? 'is-scale-changing' : null)
      .attr('viewBox', '0 0 120 320')
      .attr('role', 'img')
      .attr('aria-label', `${label}, in ${unit}`);

    const gradient = legend.append('defs')
      .append('linearGradient')
      .attr('id', 'map-gradient')
      .attr('x1', '0%')
      .attr('y1', '100%')
      .attr('x2', '0%')
      .attr('y2', '0%');

    d3.range(5).forEach(index => {
      const position = index / 4;
      const value = extent[0] + (extent[1] - extent[0]) * position;
      gradient.append('stop')
        .attr('offset', `${position * 100}%`)
        .attr('stop-color', extent[0] === undefined ? '#edf0ed' : color(value));
    });

    legend.append('rect')
      .attr('class', 'map-legend-gradient')
      .attr('x', 54)
      .attr('y', 40)
      .attr('width', 12)
      .attr('height', 240)
      .attr('rx', 6)
      .attr('fill', 'url(#map-gradient)');

    legend.append('text')
      .attr('class', 'legend-value map-legend-endpoint')
      .attr('x', 60)
      .attr('y', 24)
      .attr('text-anchor', 'middle')
      .text(`${formatNumber(extent[1], precision)} ${unit}`.trim());
    legend.append('text')
      .attr('class', 'legend-value map-legend-endpoint')
      .attr('x', 60)
      .attr('y', 304)
      .attr('text-anchor', 'middle')
      .text(`${formatNumber(extent[0], precision)} ${unit}`.trim());

  }

  return {
    render,
    createColorScale,
    metricLabel: metric => METRIC_LABELS[metric] || metric
  };
})();
