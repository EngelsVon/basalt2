import { AppWalletProvider } from './components/WalletProvider';
import { BasaltApp } from './components/BasaltApp';

function App() {
  return (
    <AppWalletProvider>
      <BasaltApp />
    </AppWalletProvider>
  );
}

export default App;
