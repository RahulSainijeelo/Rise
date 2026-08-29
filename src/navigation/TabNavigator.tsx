import { GlobalHeader } from '../components/GlobalHeader';
import { HomeScreen } from '../screens/HomeScreen';
import { TasksScreen } from '../screens/TasksScreen';
import { HabitsScreen } from '../screens/HabitsScreen';
import FocusScreen from '../screens/FocusScreen';
import { View, Platform, Image, StyleSheet } from 'react-native';
import { createBottomTabNavigator } from '@react-navigation/bottom-tabs';
import { Timer } from 'lucide-react-native';
import { useTheme } from '../theme';

// Import the PNG icons
const HomeIcon = require('../assets/tabs/home_tracker_1.png');
const TasksIcon = require('../assets/tabs/todo_tracker.png');
const HabitsIcon = require('../assets/tabs/todo_habit.png');
// Focus has no dot-matrix PNG of its own, so it borrows a vector icon rather than
// shipping a mismatched raster one.

const Tab = createBottomTabNavigator();

export const TabNavigator = ({ navigation }: any) => {
    const { theme, isDark } = useTheme();

    // Get tint color based on focus state
    const getIconTint = (focused: boolean) => {
        if (focused) return theme.colors.primary; // Red for active
        return isDark ? '#888888' : theme.colors.textSecondary; // Gray for inactive
    };

    return (
        <View style={{ flex: 1, backgroundColor: theme.colors.background }}>
            <GlobalHeader navigation={navigation} />
            <Tab.Navigator
                screenOptions={{
                    headerShown: false,
                    tabBarStyle: {
                        backgroundColor: theme.colors.background,
                        borderTopColor: theme.colors.border,
                        height: Platform.OS === 'ios' ? 96 : 80,
                        paddingBottom: Platform.OS === 'ios' ? 28 : 16,
                        paddingTop: 16,
                    },
                    tabBarActiveTintColor: theme.colors.text,
                    tabBarInactiveTintColor: theme.colors.textSecondary,
                    tabBarShowLabel: false,
                }}
            >
                <Tab.Screen
                    name="Home"
                    component={HomeScreen}
                    options={{
                        tabBarIcon: ({ focused }) => (
                            <Image
                                source={HomeIcon}
                                style={[styles.tabIconSmall, { opacity: focused ? 1 : 0.7, tintColor: getIconTint(focused) }]}
                                resizeMode="contain"
                            />
                        ),
                    }}
                />
                <Tab.Screen
                    name="Tasks"
                    component={TasksScreen}
                    options={{
                        tabBarIcon: ({ focused }) => (
                            <Image
                                source={TasksIcon}
                                style={[styles.tabIcon, { opacity: focused ? 1 : 0.7, tintColor: getIconTint(focused) }]}
                                resizeMode="contain"
                            />
                        ),
                    }}
                />
                <Tab.Screen
                    name="Habits"
                    component={HabitsScreen}
                    options={{
                        tabBarIcon: ({ focused }) => (
                            <Image
                                source={HabitsIcon}
                                style={[styles.tabIconSmall, { opacity: focused ? 1 : 0.7, tintColor: getIconTint(focused) }]}
                                resizeMode="contain"
                            />
                        ),
                    }}
                />
                <Tab.Screen
                    name="Focus"
                    component={FocusScreen}
                    options={{
                        tabBarIcon: ({ focused }) => (
                            <Timer
                                size={26}
                                color={getIconTint(focused)}
                                opacity={focused ? 1 : 0.7}
                            />
                        ),
                    }}
                />
            </Tab.Navigator>
        </View>
    );
};

const styles = StyleSheet.create({
    tabIcon: {
        width: 36,
        height: 36,
    },
    tabIconSmall: {
        width: 28,
        height: 28,
    },
});