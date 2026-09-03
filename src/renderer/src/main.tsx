import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { OperationsProvider } from './state/operations';
import { StoreProvider } from './state/store';
import './styles.css';

const container = document.getElementById('root');
if (!container) {
  throw new Error('The #root element is missing from index.html.');
}

createRoot(container).render(
  <StrictMode>
    <StoreProvider>
      {/*
        Above the router on purpose: a diagnostic that is still in flight has to
        survive the user visiting another section and coming back, or navigating
        away would forget the request and let a second one start on top of it.
      */}
      <OperationsProvider>
        <App />
      </OperationsProvider>
    </StoreProvider>
  </StrictMode>
);
