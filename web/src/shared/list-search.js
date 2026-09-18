import { escape as e, disabled, delegate, field } from './dom.js';

export const matchesSearch = (query, ...values) => values.some(value => String(value ?? '').toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()));

// Keep the draft while background refreshes redraw the surrounding list.
export function listSearch(host, life, id, placeholder, onSearch, isBusy = () => false) {
  let query = '', draft = '';
  life.add(delegate(host, 'input', `#${id}-input`, (_, input) => { draft = input.value; }));
  function apply(value) {
    if (isBusy()) return;
    query = value.trim(); draft = query; onSearch(query);
  }
  life.add(delegate(host, 'submit', `#${id}`, (event, form) => { event.preventDefault(); apply(field(form, 'query')); }));
  life.add(delegate(host, 'click', `#${id}-clear`, () => apply('')));
  return {
    get query() { return query; },
    markup() {
      return `<form id="${id}" class="list-search" role="search"><input id="${id}-input" type="search" name="query" maxlength="200" aria-label="${e(placeholder)}" placeholder="${e(placeholder)}" value="${e(draft)}"${disabled(isBusy())}><button${disabled(isBusy())}>搜索</button><button id="${id}-clear" type="button" class="text-button"${disabled(isBusy())}>清空</button></form>`;
    },
  };
}
