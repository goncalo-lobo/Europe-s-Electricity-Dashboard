(() => {
  const SOURCE_OPTIONS = [
    {value: 'Total generation', label: 'Total generation'},
    {value: 'Fossil', label: 'Fossil'},
    {value: 'Clean', label: 'Clean'},
    {value: 'Renewables', label: 'Renewables'},
    {value: 'Coal', label: 'Coal'},
    {value: 'Gas', label: 'Gas'},
    {value: 'Other fossil', label: 'Other fossil'},
    {value: 'Nuclear', label: 'Nuclear'},
    {value: 'Bioenergy', label: 'Bioenergy'},
    {value: 'Hydro', label: 'Hydro'},
    {value: 'Solar', label: 'Solar'},
    {value: 'Wind', label: 'Wind'},
    {value: 'Other renewables', label: 'Other Renewables'}
  ];

  const elements = {
    sourceFilter: document.getElementById('source-filter'),
    countryFilter: document.getElementById('country-filter'),
    countryPickerControls: document.querySelector('.country-picker-controls'),
    countryPickerTrigger: document.getElementById('country-picker-trigger'),
    countryAllTrigger: document.getElementById('country-all-trigger'),
    selectedCountryChips: document.getElementById('selected-country-chips'),
    metricFilter: document.getElementById('metric-filter'),
    yearSlider: document.getElementById('year-slider'),
    yearSliderTicks: document.getElementById('year-slider-ticks'),
    yearValue: document.getElementById('year-value'),
    mapSubtitle: document.getElementById('map-subtitle'),
    mapView: document.getElementById('map-view'),
    sparkView: document.getElementById('spark-view'),
    sparkHistoryToggle: document.getElementById('spark-history-toggle'),
    scatterView: document.getElementById('scatter-view'),
    calendarView: document.getElementById('calendar-view'),
    calendarTooltip: document.getElementById('calendar-tooltip'),
    calendarSubtitle: document.getElementById('calendar-subtitle'),
    calendarCountryTag: document.getElementById('calendar-country-tag'),
    calendarCountrySwitch: document.getElementById('calendar-country-switch'),
    treemapSubtitle: document.getElementById('treemap-subtitle'),
    treemapCountryTag: document.getElementById('treemap-country-tag'),
    generationMode: document.getElementById('generation-map-mode'),
    priceMode: document.getElementById('price-map-mode')
  };

  if (!window.d3 || !window.topojson) {
    elements.mapView.textContent = 'D3 or TopoJSON could not be loaded.';
    return;
  }

  const state = {
    year: 2025,
    source: 'Renewables',
    country: 'All countries',
    selectedCountries: [],
    metric: 'share_pct',
    sparkIncludePre2016: false,
    mapMode: 'generation',
    rows: [],
    milestones: [],
    priceRows: [],
    monthlyRows: [],
    generationYears: [],
    priceYears: [],
    topology: null
  };
  let countryPickerOpen = false;
  let countryPickerMode = 'replace';
  let calendarCountry = null;

  const toNumber = value => value === '' || value == null ? null : Number(value);
  const nonNegativeNumber = value => {
    const number = toNumber(value);
    return Number.isFinite(number) ? Math.max(0, number) : number;
  };

  function createCountryTag(country, index = Math.max(0, state.selectedCountries.indexOf(country))) {
    const tag = document.createElement('span');
    tag.className = `treemap-country-title country-tag-${index + 1}`;
    const label = document.createElement('span');
    label.textContent = country;
    tag.append(label);
    return tag;
  }

  function renderCountryTags(host, countries) {
    host.replaceChildren();
    countries.forEach(country => {
      host.append(createCountryTag(country));
    });
  }

  function drawTreemap() {
    const treemapDetails = window.ChoroplethMap.metricLabel(state.metric);
    const treemapHost = document.getElementById('treemap-view');
    renderCountryTags(elements.treemapCountryTag, state.selectedCountries.length === 2
      ? []
      : [state.selectedCountries[0] || 'All countries']);
    elements.treemapCountryTag.classList.toggle(
      'has-comparison-countries',
      state.selectedCountries.length === 2
    );

    if (state.selectedCountries.length === 2) {
      treemapHost.classList.add('has-small-multiples');
      let panels = [...treemapHost.querySelectorAll('.treemap-small-multiple')];
      const panelsMatchSelection = panels.length === 2 &&
        panels.every((panel, index) => panel.dataset.country === state.selectedCountries[index]);
      const transitionLayout = panels.length === 0
        ? window.SourceTreemap.captureLayout(treemapHost)
        : null;

      if (!panelsMatchSelection) {
        treemapHost.replaceChildren();
        panels = state.selectedCountries.map(country => {
          const panel = document.createElement('section');
          panel.className = 'treemap-small-multiple';
          panel.dataset.country = country;
          const tag = document.createElement('div');
          tag.className = 'treemap-panel-country-tag idiom-country-tags';
          const view = document.createElement('div');
          view.className = 'treemap-mini-view';
          panel.append(tag, view);
          treemapHost.append(panel);
          return panel;
        });
      }

      const smallMultiples = panels.map(panel => {
        renderCountryTags(panel.querySelector('.treemap-panel-country-tag'), [panel.dataset.country]);
        return {
          country: panel.dataset.country,
          view: panel.querySelector('.treemap-mini-view')
        };
      });

      smallMultiples.forEach(({country, view}) => {
        window.SourceTreemap.render(
          view,
          state.rows,
          {...state, country},
          selectSource,
          transitionLayout
        );
      });
      elements.treemapSubtitle.textContent =
        `${treemapDetails} · ${state.year}`;
      return;
    }

    treemapHost.classList.remove('has-small-multiples');
    window.SourceTreemap.render(
      '#treemap-view',
      state.rows,
      {...state, country: state.selectedCountries[0] || 'All countries'},
      selectSource
    );
    elements.treemapSubtitle.textContent = `${treemapDetails} · ${state.year}`;
  }

  function drawMap() {
    const mapRows = state.mapMode === 'price' ? state.priceRows : state.rows;
    elements.mapView.classList.remove('map-unavailable');
    elements.mapView.replaceChildren();
    window.ChoroplethMap.render(
      '#map-view',
      state.topology,
      mapRows,
      state,
      selectCountry
    );

    elements.yearValue.textContent = state.year;
    elements.mapSubtitle.textContent = state.mapMode === 'price'
      ? `Average household electricity price · ${state.year}`
      : [state.source, window.ChoroplethMap.metricLabel(state.metric), state.year]
        .join(' · ');
    drawTreemap();
    drawSparklines();
    drawScatterplot();
    drawCalendarHeatmap();
  }

  function drawCalendarHeatmap() {
    if (!window.CalendarHeatmap) return;
    const countries = state.selectedCountries;
    if (!countries.includes(calendarCountry)) calendarCountry = countries[0] || null;
    const canSwitch = countries.length === 2;
    elements.calendarCountrySwitch.hidden = !canSwitch;
    elements.calendarCountryTag.hidden = canSwitch;
    if (!canSwitch) {
      renderCountryTags(elements.calendarCountryTag, [countries[0] || 'All countries']);
    }
    if (canSwitch) {
      const otherCountry = countries.find(country => country !== calendarCountry);
      elements.calendarCountrySwitch.replaceChildren();
      countries.forEach((country, index) => {
        const segment = document.createElement('span');
        segment.className = `calendar-country-switch-segment country-${index + 1}${country === calendarCountry ? ' is-active' : ''}`;
        segment.textContent = country;
        elements.calendarCountrySwitch.append(segment);
      });
      elements.calendarCountrySwitch.setAttribute('aria-label', `Switch heatmap to ${otherCountry}`);
      elements.calendarCountrySwitch.title = `Switch heatmap to ${otherCountry}`;
    }
    elements.calendarSubtitle.textContent = [
      state.source,
      window.ChoroplethMap.metricLabel(state.metric)
    ].filter(Boolean).join(' · ');
    window.CalendarHeatmap.render(
      elements.calendarView,
      elements.calendarTooltip,
      state.monthlyRows,
      {...state, selectedCountries: [calendarCountry || 'All countries']},
      year => {
        if (!state.generationYears.includes(year)) return;
        state.year = year;
        elements.yearSlider.value = year;
        drawMap();
      }
    );
  }

  elements.calendarCountrySwitch.addEventListener('click', () => {
    if (state.selectedCountries.length !== 2) return;
    calendarCountry = state.selectedCountries.find(country => country !== calendarCountry);
    drawCalendarHeatmap();
  });

  function drawSparklines() {
    if (!state.rows.length || !window.SparklineTable) return;
    window.SparklineTable.draw(
      elements.sparkView,
      state.rows,
      state.priceRows,
      state,
      window.ChoroplethMap.metricLabel(state.metric),
      selectSource,
      () => setMapMode(state.mapMode === 'price' ? 'generation' : 'price'),
      year => {
        if (!state.generationYears.includes(year)) return;
        state.year = year;
        elements.yearSlider.value = year;
        drawMap();
      }
    );
  }

  elements.sparkHistoryToggle.addEventListener('click', () => {
    state.sparkIncludePre2016 = !state.sparkIncludePre2016;
    elements.sparkHistoryToggle.setAttribute('aria-pressed', String(state.sparkIncludePre2016));
    elements.sparkHistoryToggle.textContent = state.sparkIncludePre2016 ? 'Hide pre‑2016' : 'Show pre‑2016';
    drawSparklines();
  });

  function drawScatterplot() {
    if (!state.rows.length || !window.ConnectedScatterplot) return;
    window.ConnectedScatterplot.render(
      elements.scatterView,
      state.rows,
      state.milestones,
      state,
      year => {
        if (!state.generationYears.includes(year)) return;
        state.year = year;
        elements.yearSlider.value = year;
        drawMap();
      }
    );
  }

  function setMapMode(mode) {
    state.mapMode = mode;
    const years = state.generationYears;
    if (years.length) {
      const minimumYear = years[0];
      const maximumYear = years.at(-1);
      state.year = Math.max(minimumYear, Math.min(maximumYear, state.year));
      elements.yearSlider.min = minimumYear;
      elements.yearSlider.max = maximumYear;
      elements.yearSlider.value = state.year;
      renderYearSliderTicks(minimumYear, maximumYear, mode === 'price');
    }
    elements.generationMode.classList.toggle('active', mode === 'generation');
    elements.priceMode.classList.toggle('active', mode === 'price');
    elements.generationMode.setAttribute('aria-pressed', String(mode === 'generation'));
    elements.priceMode.setAttribute('aria-pressed', String(mode === 'price'));
    if (state.topology) drawMap();
    if (state.rows.length) drawSparklines();
  }

  function renderYearSliderTicks(firstYear, lastYear, showPriceStart = false) {
    const years = d3.range(firstYear, lastYear + 1);
    elements.yearSliderTicks.replaceChildren();
    years.forEach((year, index) => {
      const tick = document.createElement('span');
      tick.className = 'year-slider-tick';
      if (year === 2016 && showPriceStart) tick.classList.add('is-price-start');
      if (index === 0) tick.classList.add('is-first');
      if (index === years.length - 1) tick.classList.add('is-last');
      tick.style.left = `${years.length === 1 ? 50 : index / (years.length - 1) * 100}%`;

      const mark = document.createElement('span');
      mark.className = 'year-slider-tick-mark';
      const label = document.createElement('span');
      label.className = 'year-slider-tick-label';
      label.textContent = year % 5 === 0 ? String(year) : String(year).slice(-2);
      tick.append(mark, label);
      if (year === 2016 && showPriceStart) {
        const note = document.createElement('span');
        note.className = 'year-slider-price-note';
        note.textContent = 'Price data starts here';
        elements.yearSliderTicks.append(note);
      }
      elements.yearSliderTicks.append(tick);
    });
    positionPriceStartNote();
  }

  function positionPriceStartNote() {
    const note = elements.yearSliderTicks.querySelector('.year-slider-price-note');
    if (!note) return;
    const sliderBounds = elements.yearSlider.getBoundingClientRect();
    const ticksBounds = elements.yearSliderTicks.getBoundingClientRect();
    const minimumYear = Number(elements.yearSlider.min);
    const maximumYear = Number(elements.yearSlider.max);
    const yearRatio = (2016 - minimumYear) / (maximumYear - minimumYear || 1);
    const thumbRadius = 7;
    const thumbCenter = sliderBounds.left + thumbRadius + yearRatio * (sliderBounds.width - thumbRadius * 2);
    note.style.left = `${thumbCenter - ticksBounds.left}px`;
  }

  const yearSliderResizeObserver = new ResizeObserver(positionPriceStartNote);
  yearSliderResizeObserver.observe(elements.yearSlider);

  const treemapResizeObserver = new ResizeObserver(() => {
    if (state.rows.length) drawTreemap();
  });
  treemapResizeObserver.observe(document.getElementById('treemap-view'));

  const sparkResizeObserver = new ResizeObserver(() => {
    if (state.rows.length) drawSparklines();
  });
  sparkResizeObserver.observe(elements.sparkView);

  const scatterResizeObserver = new ResizeObserver(() => {
    if (state.rows.length) drawScatterplot();
  });
  scatterResizeObserver.observe(elements.scatterView);

  const calendarResizeObserver = new ResizeObserver(() => {
    if (state.monthlyRows.length) drawCalendarHeatmap();
  });
  calendarResizeObserver.observe(elements.calendarView);

  const mapResizeObserver = new ResizeObserver(() => {
    if (state.topology) drawMap();
  });
  mapResizeObserver.observe(elements.mapView);

  function populateOptions(select, options, selectedValue) {
    select.replaceChildren();

    const normalizedOptions = options.map(option =>
      typeof option === 'string'
        ? {value: option, label: option}
        : {value: option.value, label: option.label || option.value}
    );

    normalizedOptions.forEach(({value, label}) => {
      const option = document.createElement('option');
      option.value = value;
      option.textContent = label;
      select.append(option);
    });

    const availableValues = normalizedOptions.map(option => option.value);
    select.value = availableValues.includes(selectedValue)
      ? selectedValue
      : availableValues[0];
    return select.value;
  }

  function selectCountry(country, selectNext = false) {
    countryPickerOpen = false;
    const heatmapCountryIndex = state.selectedCountries.indexOf(calendarCountry);
    if (country === 'All countries' && !selectNext) {
      state.selectedCountries = [];
    } else if (selectNext) {
      const selectedIndex = state.selectedCountries.indexOf(country);
      if (selectedIndex >= 0) {
        state.selectedCountries.splice(selectedIndex, 1);
      } else if (state.selectedCountries.length === 0) {
        state.selectedCountries = country === 'All countries' ? [] : [country];
      } else if (state.selectedCountries.length < 2) {
        state.selectedCountries.push(country);
      } else {
        state.selectedCountries[1] = country;
      }
    } else {
      state.selectedCountries = state.selectedCountries.length === 1 &&
        state.selectedCountries[0] === country
        ? []
        : [country];
    }

    state.country = state.selectedCountries.length === 1 &&
      state.selectedCountries[0] !== 'All countries'
      ? state.selectedCountries[0]
      : 'All countries';
    // Keep the heatmap on the same comparison slot when countries change.
    // This also follows a map replacement when the second slot is active.
    const heatmapIndex = heatmapCountryIndex >= 0 ? heatmapCountryIndex : 0;
    calendarCountry = state.selectedCountries[heatmapIndex] ||
      state.selectedCountries[0] || null;
    syncCountrySelectionControls();
    drawMap();
  }

  function syncCountrySelectionControls() {
    elements.countryPickerControls.classList.toggle('is-open', countryPickerOpen);
    elements.countryFilter.hidden = !countryPickerOpen;
    elements.countryPickerTrigger.hidden = countryPickerOpen || state.selectedCountries.length >= 2;
    elements.countryAllTrigger.hidden = countryPickerOpen || state.selectedCountries.length > 0;
    elements.countryPickerTrigger.textContent = '+';
    elements.countryPickerTrigger.setAttribute('aria-label', 'Add a country to compare');
    elements.countryFilter.value = '';
    elements.selectedCountryChips.replaceChildren();

    state.selectedCountries.forEach(country => {
      const chip = document.createElement('span');
      chip.className = 'selected-country-chip';
      const label = document.createElement('span');
      label.textContent = country;
      const remove = document.createElement('button');
      remove.type = 'button';
      remove.className = 'remove-country-chip';
      remove.textContent = '×';
      remove.setAttribute('aria-label', `Remove ${country}`);
      remove.addEventListener('click', () => selectCountry(country, true));
      chip.append(label, remove);
      elements.selectedCountryChips.append(chip);
    });
  }

  function selectSource(source) {
    elements.sourceFilter.value = source;
    state.source = source;
    if (state.mapMode !== 'generation') {
      setMapMode('generation');
      return;
    }
    drawMap();
  }

  function handleLoadError(error) {
    console.error('Could not load choropleth inputs:', error);
    elements.mapView.textContent =
      'Check the local server and internet connection for the map boundary data.';
  }

  function initializeDashboard([rows, topology, semesterPrices, milestones, monthlyRows]) {
    state.rows = rows;
    state.topology = topology;
    state.milestones = milestones;
    state.monthlyRows = monthlyRows;
    state.priceRows = d3.rollups(
      semesterPrices.filter(row => Number.isFinite(row.price_eur_kwh)),
      values => d3.mean(values, row => row.price_eur_kwh),
      row => row.country,
      row => row.year
    ).flatMap(([country, years]) => years.map(([year, price]) => ({
      country,
      year,
      price_eur_kwh: price
    })));

    state.generationYears = [...new Set(rows.map(row => row.year))]
      .sort((a, b) => a - b);
    state.priceYears = [...new Set(state.priceRows.map(row => row.year))]
      .sort((a, b) => a - b);
    const years = state.mapMode === 'price'
      ? state.priceYears
      : state.generationYears;
    const availableSources = new Set(rows.map(row => row.source));
    const sources = SOURCE_OPTIONS.filter(source =>
      availableSources.has(source.value)
    );
    const countries = [...new Set(rows.map(row => row.country))]
      .sort((a, b) => a.localeCompare(b));

    state.year = years.includes(2025) ? 2025 : years.at(-1);
    state.source = populateOptions(elements.sourceFilter, sources, state.source);
    populateOptions(elements.countryFilter, [
      {value: '', label: 'Choose a country'},
      'All countries',
      'EU',
      'Non-EU',
      ...countries.filter(country => country !== 'EU' && country !== 'Non-EU')
    ], '');
    syncCountrySelectionControls();

    const sliderMinimumYear = state.generationYears[0];
    const sliderMaximumYear = state.generationYears.at(-1);
    state.year = Math.max(sliderMinimumYear, Math.min(sliderMaximumYear, state.year));
    elements.yearSlider.min = sliderMinimumYear;
    elements.yearSlider.max = sliderMaximumYear;
    elements.yearSlider.value = state.year;
    renderYearSliderTicks(sliderMinimumYear, sliderMaximumYear, state.mapMode === 'price');

    drawMap();
  }

  Promise.all([
    d3.csv('data-processing/export/generation_by_source_year.csv', row => {
      const generation = toNumber(row.generation_twh);
      const share = toNumber(row.share_pct);
      const clipNegativeGeneration = ['Other renewables', 'Other fossil'].includes(row.source);
      return {
        country: row.country,
        year: Number(row.year),
        source: row.source,
        // Preserve negative net imports, but treat negative generation in these
        // small residual categories as zero in the dashboard's in-memory data.
        generation_twh: clipNegativeGeneration && generation < 0 ? 0 : generation,
        share_pct: clipNegativeGeneration && share < 0 ? 0 : share,
        emissions_intensity_gco2e_kwh: toNumber(row.emissions_intensity_gco2e_kwh)
      };
    }),
    d3.json('vendor/countries-50m.json'),
    d3.csv('data-processing/export/prices.csv', row => ({
      country: row.country,
      year: Number(row.year),
      semester: Number(row.semester),
      price_eur_kwh: toNumber(row.price_eur_kwh)
    })),
    d3.csv('data-processing/export/country_milestones.csv', row => ({
      country: row.country,
      milestone_year: Number(row.milestone_year)
    })),
    d3.csv('data-processing/export/source_month_generated.csv', row => ({
      area: row.area,
      area_type: row.area_type,
      source: row.source,
      year: Number(row.year),
      month: Number(row.month),
      total_generated: toNumber(row.total_generated),
      share_pct: toNumber(row.share_pct),
      emissions_intensity_gco2e_kwh: toNumber(row.emissions_intensity_gco2e_kwh)
    }))
  ])
    .then(initializeDashboard)
    .catch(handleLoadError);

  elements.sourceFilter.addEventListener('change', () => {
    state.source = elements.sourceFilter.value;
    if (state.mapMode !== 'generation') {
      setMapMode('generation');
      return;
    }
    if (state.topology) drawMap();
  });

  elements.countryFilter.addEventListener('change', () => {
    const country = elements.countryFilter.value;
    if (countryPickerOpen && country && state.selectedCountries.length < 2 &&
        !state.selectedCountries.includes(country)) {
      selectCountry(country, countryPickerMode === 'compare');
    }
  });
  elements.countryFilter.addEventListener('blur', () => {
    if (!countryPickerOpen) return;
    countryPickerOpen = false;
    syncCountrySelectionControls();
  });

  function openCountryPicker(mode) {
    countryPickerMode = mode;
    countryPickerOpen = true;
    [...elements.countryFilter.options].forEach(option => {
      if (!option.value) return;
      option.hidden = state.selectedCountries.includes(option.value) ||
        (option.value === 'All countries' &&
          (mode !== 'compare' || state.selectedCountries.length === 0));
    });
    syncCountrySelectionControls();
    elements.countryFilter.focus();
  }

  elements.countryAllTrigger.addEventListener('click', () => openCountryPicker('replace'));
  elements.countryPickerTrigger.addEventListener('click', () => openCountryPicker('compare'));

  elements.metricFilter.addEventListener('change', () => {
    state.metric = elements.metricFilter.value;
    if (state.topology) drawMap();
  });

  elements.yearSlider.addEventListener('input', () => {
    state.year = Number(elements.yearSlider.value);
    if (state.topology) drawMap();
  });

  elements.generationMode.addEventListener('click', () => setMapMode('generation'));
  elements.priceMode.addEventListener('click', () => setMapMode('price'));
})();
